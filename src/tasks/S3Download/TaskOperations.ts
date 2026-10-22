/*!
 * Copyright 2019 Amazon.com, Inc. or its affiliates. All Rights Reserved.
 * SPDX-License-Identifier: MIT
 */

import { S3 } from 'aws-sdk/clients/all'
import * as tl from 'azure-pipelines-task-lib/task'
import * as fs from 'fs'
import * as mm from 'minimatch'
import * as path from 'path'

import { testBucketExists } from 'lib/s3'
import { aes256AlgorithmValue, customerManagedKeyValue, TaskParameters } from './TaskParameters'

export class TaskOperations {
    public constructor(public readonly s3Client: S3, public readonly taskParameters: TaskParameters) {}

    public async execute(): Promise<void> {
        const exists = await testBucketExists(this.s3Client, this.taskParameters.bucketName)
        if (!exists) {
            throw new Error(tl.loc('BucketNotExist', this.taskParameters.bucketName))
        }

        await this.downloadFiles()

        console.log(tl.loc('TaskCompleted'))
    }

    private async downloadFiles() {
        let msgSource: string
        if (this.taskParameters.sourceFolder) {
            msgSource = this.taskParameters.sourceFolder
        } else {
            msgSource = '/'
        }
        console.log(
            tl.loc('DownloadingFiles', msgSource, this.taskParameters.bucketName, this.taskParameters.targetFolder)
        )

        if (!fs.existsSync(this.taskParameters.targetFolder)) {
            tl.mkdirP(this.taskParameters.targetFolder)
        }

        const allDownloads = []
        const allKeys = await this.fetchAllObjectKeys()
        const root = path.resolve(this.taskParameters.targetFolder)
        for (const glob of this.taskParameters.globExpressions) {
            const matchedKeys = await this.matchObjectKeys(allKeys, this.taskParameters.sourceFolder, glob)
            for (const matchedKey of matchedKeys) {
                const isDirKey: boolean = matchedKey.endsWith('/') || matchedKey.endsWith('\\')
                let dest: string
                if (this.taskParameters.flattenFolders) {
                    const fname: string = path.basename(matchedKey)
                    dest = path.resolve(root, fname)
                } else {
                    // Reject keys that attempt path traversal or absolute-path escape.
                    // S3 object keys are opaque strings - we do not trust them as filesystem
                    // paths. Reject backslashes (illegal segment separators on Windows that
                    // are legal in S3 keys), a leading '/' (makes path.resolve ignore the
                    // root), and any '..' segment. Then normalise to forward-slash segments
                    // and resolve against the target root.
                    const normalisedKey: string = matchedKey.replace(/\\/g, '/')
                    const segments: string[] = normalisedKey.split('/')
                    const hasTraversal: boolean =
                        matchedKey.indexOf('\\') !== -1 ||
                        normalisedKey.startsWith('/') ||
                        segments.some(seg => seg === '..')
                    if (hasTraversal) {
                        console.log(tl.loc('SkippingUnsafeKey', matchedKey))
                        continue
                    }
                    dest = path.resolve(root, normalisedKey)
                }

                // Containment check: dest must be at or under the resolved target root.
                // Also resolve the parent directory through realpath (when it already
                // exists) so pre-existing symlinks inside the target cannot redirect the
                // write outside the root.
                let containmentDest: string = dest
                const parentDir: string = path.dirname(dest)
                if (fs.existsSync(parentDir)) {
                    try {
                        const realParent: string = fs.realpathSync(parentDir)
                        containmentDest = path.resolve(realParent, path.basename(dest))
                    } catch (err) {
                        console.log(tl.loc('SkippingUnsafeKey', matchedKey))
                        continue
                    }
                }
                if (containmentDest !== root && !containmentDest.startsWith(root + path.sep)) {
                    console.log(tl.loc('SkippingUnsafeKey', matchedKey))
                    continue
                }
                dest = containmentDest
                // Preserve the directory-marker semantics expected by downloadFile:
                // keys ending in a separator represent S3 folder markers.
                if (isDirKey && !dest.endsWith(path.sep)) {
                    dest = dest + path.sep
                }

                if (fs.existsSync(dest)) {
                    if (this.taskParameters.overwrite) {
                        console.log(tl.loc('FileOverwriteWarning', dest, matchedKey))
                    } else {
                        throw new Error(tl.loc('FileExistsError', dest, matchedKey))
                    }
                }

                console.log(tl.loc('QueueingDownload', matchedKey))
                const params: S3.GetObjectRequest = {
                    Bucket: this.taskParameters.bucketName,
                    Key: matchedKey
                }
                if (this.taskParameters.keyManagement === customerManagedKeyValue) {
                    params.SSECustomerAlgorithm = aes256AlgorithmValue
                    if (this.taskParameters.customerKey.length > 0) {
                        params.SSECustomerKey = this.taskParameters.customerKey
                    }
                }
                allDownloads.push(this.downloadFile(params, dest))
            }
        }

        return Promise.all(allDownloads)
    }

    private async downloadFile(s3Params: S3.GetObjectRequest, dest: string): Promise<void> {
        return new Promise<void>((resolve, reject) => {
            const isDir = dest.endsWith('/')
            if (isDir) {
                this.createDirectory(dest)
            } else {
                const dir: string = path.dirname(dest)
                this.createDirectory(dir)
                const file = fs.createWriteStream(dest)
                const s3Stream = this.s3Client.getObject(s3Params).createReadStream()
                s3Stream.on('error', reject)
                file.on('error', reject)
                file.on('close', resolve)
                s3Stream.pipe(file)
            }
        })
    }

    private createDirectory(path: string) {
        if (!fs.existsSync(path)) {
            tl.mkdirP(path)
        }
    }

    private async fetchAllObjectKeys(): Promise<string[]> {
        if (this.taskParameters.sourceFolder) {
            console.log(
                tl.loc('ListingKeysFromPrefix', this.taskParameters.sourceFolder, this.taskParameters.bucketName)
            )
        } else {
            console.log(tl.loc('ListingKeysFromRoot', this.taskParameters.bucketName))
        }

        const allKeys: string[] = []
        // tslint:disable-next-line:no-unnecessary-initializer
        let nextToken: string | undefined = undefined
        do {
            const params: S3.ListObjectsV2Request = {
                Bucket: this.taskParameters.bucketName,
                Prefix: this.taskParameters.sourceFolder,
                ContinuationToken: nextToken
            }
            try {
                const s3Data = await this.s3Client.listObjectsV2(params).promise()
                nextToken = s3Data.NextContinuationToken
                if (s3Data.Contents) {
                    s3Data.Contents.forEach(s3object => {
                        // AWS IDE toolkits can cause 0 byte 'folder markers' to be in the bucket,
                        // filter those out
                        if (s3object.Key) {
                            if (!s3object.Key.endsWith('_$folder$')) {
                                allKeys.push(s3object.Key)
                            }
                        }
                    })
                }
            } catch (err) {
                console.error(err)
                nextToken = undefined
            }
        } while (nextToken)

        return allKeys
    }

    private async matchObjectKeys(allKeys: string[], sourcePrefix: string, glob: string): Promise<string[]> {
        let sourcePrefixLen = 0
        if (sourcePrefix) {
            console.log(tl.loc('GlobbingFromPrefix', sourcePrefix, glob))
            sourcePrefixLen = sourcePrefix.length + 1
        } else {
            console.log(tl.loc('GlobbingFromRoot', glob))
        }

        const matcher = new mm.Minimatch(glob)
        const matchedKeys: string[] = []
        allKeys.forEach(key => {
            const keyToTest: string = key.substring(sourcePrefixLen)
            if (matcher.match(keyToTest)) {
                tl.debug(tl.loc('MatchedKey', key))
                matchedKeys.push(key)
            }
        })

        return matchedKeys
    }
}
