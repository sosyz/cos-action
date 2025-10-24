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

const uploadFileToCOS = (
	cos: COSInstance,
	filePath: string,
): Promise<unknown> => {
	return new Promise((resolve, reject) => {
		cos.cli.putObject(
			{
				Bucket: cos.bucket,
				Region: cos.region,
				Key: path.join(cos.remotePath, filePath),
				Body: fs.createReadStream(path.join(cos.localPath, filePath)),
			},
			(err: unknown, data: unknown) => {
				if (err) {
					const errorMessage = err instanceof Error ? err.message : String(err);
					return reject(
						new Error(`Upload failed for ${filePath}: ${errorMessage}`),
					);
				} else {
					return resolve(data);
				}
			},
		);
	});
};

const deleteFileFromCOS = (
	cos: COSInstance,
	filePath: string,
): Promise<unknown> => {
	return new Promise((resolve, reject) => {
		cos.cli.deleteObject(
			{
				Bucket: cos.bucket,
				Region: cos.region,
				Key: path.join(cos.remotePath, filePath),
			},
			(err: unknown, data: unknown) => {
				if (err) {
					const errorMessage = err instanceof Error ? err.message : String(err);
					return reject(
						new Error(`Delete failed for ${filePath}: ${errorMessage}`),
					);
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
	const size = localFiles.size;
	let index = 0;
	let percent = 0;
	for (const file of localFiles) {
		await uploadFileToCOS(cos, file);
		index++;
		percent = Math.floor((index / size) * 100);
		console.log(
			`>> [${index}/${size}, ${percent}%] uploaded ${path.join(cos.localPath, file)}`,
		);
	}
};

const collectRemoteFiles = async (cos: COSInstance): Promise<Set<string>> => {
	const files = new Set<string>();
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
				files.add(relativePath);
			}
		}
		nextMarker = data.NextMarker;
	} while (data.IsTruncated === "true");

	return files;
};

const findDeletedFiles = (
	localFiles: Set<string>,
	remoteFiles: Set<string>,
): Set<string> => {
	const deletedFiles = new Set<string>();
	for (const file of remoteFiles) {
		if (!localFiles.has(file)) {
			deletedFiles.add(file);
		}
	}
	return deletedFiles;
};

const cleanDeleteFiles = async (
	cos: COSInstance,
	deleteFiles: Set<string>,
): Promise<void> => {
	const size = deleteFiles.size;
	let index = 0;
	let percent = 0;
	for (const file of deleteFiles) {
		await deleteFileFromCOS(cos, file);
		index++;
		percent = Math.floor((index / size) * 100);
		console.log(
			`>> [${index}/${size}, ${percent}%] cleaned ${path.join(cos.remotePath, file)}`,
		);
	}
};

const process = async (cos: COSInstance): Promise<void> => {
	try {
		const localFiles = await collectLocalFiles(cos);
		console.log(localFiles.size, "files to be uploaded");
		await uploadFiles(cos, localFiles);
		let cleanedFilesCount = 0;
		if (cos.clean) {
			const remoteFiles = await collectRemoteFiles(cos);
			const deletedFiles = findDeletedFiles(localFiles, remoteFiles);
			if (deletedFiles.size > 0) {
				console.log(`${deletedFiles.size} files to be cleaned`);
			}
			await cleanDeleteFiles(cos, deletedFiles);
			cleanedFilesCount = deletedFiles.size;
		}
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
