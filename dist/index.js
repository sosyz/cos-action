"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const core = __importStar(require("@actions/core"));
const cos_nodejs_sdk_v5_1 = __importDefault(require("cos-nodejs-sdk-v5"));
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const walk = async (dirPath, walkFn) => {
    try {
        const stats = await fs.promises.lstat(dirPath);
        if (!stats.isDirectory()) {
            return await walkFn(dirPath);
        }
        const dir = await fs.promises.opendir(dirPath);
        for await (const dirent of dir) {
            await walk(path.join(dirPath, dirent.name), walkFn);
        }
    }
    catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        throw new Error(`Failed to walk directory ${dirPath}: ${errorMessage}`);
    }
};
const uploadFileToCOS = (cos, filePath) => {
    return new Promise((resolve, reject) => {
        cos.cli.putObject({
            Bucket: cos.bucket,
            Region: cos.region,
            Key: path.join(cos.remotePath, filePath),
            StorageClass: "STANDARD",
            Body: fs.createReadStream(path.join(cos.localPath, filePath)),
        }, (err, data) => {
            if (err) {
                const errorMessage = err instanceof Error ? err.message : String(err);
                return reject(new Error(`Upload failed for ${filePath}: ${errorMessage}`));
            }
            else {
                return resolve(data);
            }
        });
    });
};
const deleteFileFromCOS = (cos, filePath) => {
    return new Promise((resolve, reject) => {
        cos.cli.deleteObject({
            Bucket: cos.bucket,
            Region: cos.region,
            Key: path.join(cos.remotePath, filePath),
        }, (err, data) => {
            if (err) {
                const errorMessage = err instanceof Error ? err.message : String(err);
                return reject(new Error(`Delete failed for ${filePath}: ${errorMessage}`));
            }
            else {
                return resolve(data);
            }
        });
    });
};
const listFilesOnCOS = (cos, nextMarker) => {
    return new Promise((resolve, reject) => {
        const params = {
            Bucket: cos.bucket,
            Region: cos.region,
            Prefix: cos.remotePath,
        };
        if (nextMarker) {
            params["Marker"] = nextMarker;
        }
        cos.cli.getBucket(params, (err, data) => {
            if (err) {
                const errorMessage = err instanceof Error ? err.message : String(err);
                return reject(new Error(`List files failed: ${errorMessage}`));
            }
            else {
                return resolve(data);
            }
        });
    });
};
const collectLocalFiles = async (cos) => {
    const root = cos.localPath;
    const files = new Set();
    await walk(root, async (filePath) => {
        let relativePath = filePath.substring(root.length);
        while (relativePath[0] === "/") {
            relativePath = relativePath.substring(1);
        }
        files.add(relativePath);
    });
    return files;
};
const uploadFiles = async (cos, localFiles) => {
    const size = localFiles.size;
    let index = 0;
    let percent = 0;
    for (const file of localFiles) {
        await uploadFileToCOS(cos, file);
        index++;
        percent = Math.floor((index / size) * 100);
        console.log(`>> [${index}/${size}, ${percent}%] uploaded ${path.join(cos.localPath, file)}`);
    }
};
const collectRemoteFiles = async (cos) => {
    const files = new Set();
    let data = {};
    let nextMarker = undefined;
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
const findDeletedFiles = (localFiles, remoteFiles) => {
    const deletedFiles = new Set();
    for (const file of remoteFiles) {
        if (!localFiles.has(file)) {
            deletedFiles.add(file);
        }
    }
    return deletedFiles;
};
const cleanDeleteFiles = async (cos, deleteFiles) => {
    const size = deleteFiles.size;
    let index = 0;
    let percent = 0;
    for (const file of deleteFiles) {
        await deleteFileFromCOS(cos, file);
        index++;
        percent = Math.floor((index / size) * 100);
        console.log(`>> [${index}/${size}, ${percent}%] cleaned ${path.join(cos.remotePath, file)}`);
    }
};
const process = async (cos) => {
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
    }
    catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        throw new Error(`Process failed: ${errorMessage}`);
    }
};
try {
    const cosConfig = {
        SecretId: core.getInput("secret_id"),
        SecretKey: core.getInput("secret_key"),
    };
    if (core.getInput("accelerate") === "true") {
        cosConfig["Domain"] = "{Bucket}.cos.accelerate.myqcloud.com";
    }
    const cos = {
        cli: new cos_nodejs_sdk_v5_1.default(cosConfig),
        bucket: core.getInput("cos_bucket"),
        region: core.getInput("cos_region"),
        localPath: core.getInput("local_path"),
        remotePath: core.getInput("remote_path"),
        clean: core.getInput("clean") === "true",
    };
    process(cos).catch((reason) => {
        const errorMessage = reason instanceof Error ? reason.message : String(reason);
        core.setFailed(`fail to upload files to cos: ${errorMessage}`);
    });
}
catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    core.setFailed(errorMessage);
}
//# sourceMappingURL=index.js.map