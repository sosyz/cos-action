import * as core from "@actions/core";
import COS from "cos-nodejs-sdk-v5";
import * as fs from "fs";
import * as path from "path";

interface COSInstance {
	cli: COS;
	bucket: string;
	region: string;
	localPath: string;
	remotePath: string;
	clean: boolean;
}

interface COSResponse {
	Contents?: Array<{
		Key: string;
	}>;
	NextMarker?: string;
	IsTruncated?: string;
}

const walk = async (
	dirPath: string,
	walkFn: (path: string) => Promise<void>,
): Promise<void> => {
	try {
		const stats = await fs.promises.lstat(dirPath);
		if (!stats.isDirectory()) {
			return await walkFn(dirPath);
		}

		const dir = await fs.promises.opendir(dirPath);
		for await (const dirent of dir) {
			await walk(path.join(dirPath, dirent.name), walkFn);
		}
	} catch (error) {
		const errorMessage = error instanceof Error ? error.message : String(error);
		throw new Error(`Failed to walk directory ${dirPath}: ${errorMessage}`);
	}
};

const deleteMultipleFilesFromCOS = (
	cos: COSInstance,
	filePaths: string[],
): Promise<unknown> => {
	return new Promise((resolve, reject) => {
		if (filePaths.length === 0) {
			return resolve({ Deleted: [] });
		}

		const objects = filePaths.map((filePath) => ({
			Key: path.join(cos.remotePath, filePath),
		}));

		cos.cli.deleteMultipleObject(
			{
				Bucket: cos.bucket,
				Region: cos.region,
				Objects: objects,
			},
			(err: unknown, data: unknown) => {
				if (err) {
					const errorMessage = err instanceof Error ? err.message : String(err);
					return reject(new Error(`Batch delete failed: ${errorMessage}`));
				} else {
					return resolve(data);
				}
			},
		);
	});
};

const listFilesOnCOS = (
	cos: COSInstance,
	nextMarker?: string,
): Promise<COSResponse> => {
	return new Promise((resolve, reject) => {
		const params: Record<string, string> = {
			Bucket: cos.bucket,
			Region: cos.region,
			Prefix: cos.remotePath,
		};
		if (nextMarker) {
			params["Marker"] = nextMarker;
		}
		cos.cli.getBucket(params as any, (err: unknown, data: COSResponse) => {
			if (err) {
				const errorMessage = err instanceof Error ? err.message : String(err);
				return reject(new Error(`List files failed: ${errorMessage}`));
			} else {
				return resolve(data);
			}
		});
	});
};

const collectLocalFiles = async (cos: COSInstance): Promise<Set<string>> => {
	const root = cos.localPath;
	const files = new Set<string>();
	await walk(root, async (filePath: string) => {
		let relativePath = filePath.substring(root.length);
		while (relativePath[0] === "/") {
			relativePath = relativePath.substring(1);
		}
		files.add(relativePath);
	});
	return files;
};

const uploadFiles = async (
	cos: COSInstance,
	localFiles: Set<string>,
): Promise<void> => {
	if (localFiles.size === 0) {
		console.log("No files to upload");
		return;
	}

	const files = Array.from(localFiles).map((file) => ({
		Bucket: cos.bucket,
		Region: cos.region,
		Key: path.join(cos.remotePath, file),
		FilePath: path.join(cos.localPath, file),
	}));

	return new Promise((resolve, reject) => {
		let uploadedCount = 0;
		const totalCount = files.length;

		cos.cli.uploadFiles(
			{
				files: files,
				SliceSize: 1024 * 1024 * 5,
				onProgress: (info: any) => {
					const percent = Math.floor((info.percent || 0) * 100);
					console.log(`Overall progress: ${percent}%`);
				},
				onFileFinish: (err: unknown, _data: unknown, options: any) => {
					uploadedCount++;
					const percent = Math.floor((uploadedCount / totalCount) * 100);
					if (err) {
						const errorMessage =
							err instanceof Error ? err.message : String(err);
						console.error(
							`>> [${uploadedCount}/${totalCount}, ${percent}%] failed ${options.Key}: ${errorMessage}`,
						);
					} else {
						console.log(
							`>> [${uploadedCount}/${totalCount}, ${percent}%] uploaded ${options.Key}`,
						);
					}
				},
			},
			(err: unknown, _data: unknown) => {
				if (err) {
					const errorMessage = err instanceof Error ? err.message : String(err);
					return reject(new Error(`Batch upload failed: ${errorMessage}`));
				} else {
					return resolve();
				}
			},
		);
	});
};

const collectRemoteFiles = async (cos: COSInstance): Promise<string[]> => {
	const files: string[] = [];
	let data: COSResponse = {};
	let nextMarker: string | undefined = undefined;

	do {
		data = await listFilesOnCOS(cos, nextMarker);
		if (data.Contents) {
			for (const entry of data.Contents) {
				let relativePath = entry.Key.substring(cos.remotePath.length);
				while (relativePath[0] === "/") {
					relativePath = relativePath.substring(1);
				}
				if (relativePath) {
					files.push(relativePath);
				}
			}
		}
		nextMarker = data.NextMarker;
	} while (data.IsTruncated === "true");

	return files;
};

const cleanRemotePath = async (cos: COSInstance): Promise<number> => {
	console.log(`Cleaning remote path: ${cos.remotePath}`);

	const remoteFiles = await collectRemoteFiles(cos);

	if (remoteFiles.length === 0) {
		console.log("Remote path is already empty");
		return 0;
	}

	console.log(`Found ${remoteFiles.length} files to delete`);

	const batchSize = 1000;
	let totalCleaned = 0;

	for (let i = 0; i < remoteFiles.length; i += batchSize) {
		const batch = remoteFiles.slice(i, i + batchSize);
		await deleteMultipleFilesFromCOS(cos, batch);
		totalCleaned += batch.length;
		const percent = Math.floor((totalCleaned / remoteFiles.length) * 100);
		console.log(
			`>> [${totalCleaned}/${remoteFiles.length}, ${percent}%] deleted`,
		);
	}

	console.log(`Remote path cleaned: deleted ${totalCleaned} files`);
	return totalCleaned;
};

const process = async (cos: COSInstance): Promise<void> => {
	try {
		let cleanedFilesCount = 0;

		if (cos.clean) {
			cleanedFilesCount = await cleanRemotePath(cos);
		}

		const localFiles = await collectLocalFiles(cos);
		console.log(localFiles.size, "files to be uploaded");
		await uploadFiles(cos, localFiles);

		let cleanedFilesMessage = "";
		if (cleanedFilesCount > 0) {
			cleanedFilesMessage = `, cleaned ${cleanedFilesCount} files`;
		}
		console.log(`uploaded ${localFiles.size} files${cleanedFilesMessage}`);
	} catch (error) {
		const errorMessage = error instanceof Error ? error.message : String(error);
		throw new Error(`Process failed: ${errorMessage}`);
	}
};

try {
	const cosConfig: Record<string, string> = {
		SecretId: core.getInput("secret_id"),
		SecretKey: core.getInput("secret_key"),
	};
	if (core.getInput("accelerate") === "true") {
		cosConfig["Domain"] = "{Bucket}.cos.accelerate.myqcloud.com";
	}

	const cos: COSInstance = {
		cli: new COS(cosConfig),
		bucket: core.getInput("cos_bucket"),
		region: core.getInput("cos_region"),
		localPath: core.getInput("local_path"),
		remotePath: core.getInput("remote_path"),
		clean: core.getInput("clean") === "true",
	};

	process(cos).catch((reason: unknown) => {
		const errorMessage =
			reason instanceof Error ? reason.message : String(reason);
		core.setFailed(`fail to upload files to cos: ${errorMessage}`);
	});
} catch (error) {
	const errorMessage = error instanceof Error ? error.message : String(error);
	core.setFailed(errorMessage);
}
