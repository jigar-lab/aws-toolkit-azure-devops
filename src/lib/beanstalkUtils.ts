/*!
 * Copyright 2019 Amazon.com, Inc. or its affiliates. All Rights Reserved.
 * SPDX-License-Identifier: MIT
 */

import * as tl from 'azure-pipelines-task-lib/task'

import { ElasticBeanstalk, S3 } from 'aws-sdk/clients/all'
import fs = require('fs')
import path = require('path')
import AdmZip = require('adm-zip')

export class BeanstalkUtils {
    public static async determineS3Bucket(beanstalkClient: ElasticBeanstalk): Promise<string> {
        const response = await beanstalkClient.createStorageLocation().promise()
        console.log(tl.loc('DeterminedBucket', response.S3Bucket))

        if (!response.S3Bucket) {
            return ''
        }

        return response.S3Bucket
    }

    /**
     * Safely add every regular file beneath `localFolder` to `zip` under the given
     * `zipPathPrefix`. Symbolic links are skipped, and any file whose realpath
     * escapes `localFolder` is excluded. This prevents a symlink committed inside
     * the published folder from exfiltrating arbitrary agent-local files (for
     * example AWS credential or agent diagnostic log files) into the deployment
     * bundle that is uploaded to S3.
     */
    public static addLocalFolderSafe(zip: AdmZip, localFolder: string, zipPathPrefix: string = ''): void {
        const resolvedRoot = path.resolve(localFolder)

        const walk = (currentDir: string, currentZipPath: string): void => {
            const entries = fs.readdirSync(currentDir)
            for (const entry of entries) {
                const absEntry = path.join(currentDir, entry)
                let lst: fs.Stats
                try {
                    lst = fs.lstatSync(absEntry)
                } catch (err) {
                    tl.debug(`Skipping ${absEntry}: ${(err as Error).message}`)
                    continue
                }
                if (lst.isSymbolicLink()) {
                    tl.warning(
                        `Skipping symbolic link ${absEntry}: symlinks are not followed when creating the deployment bundle`
                    )
                    continue
                }
                if (lst.isDirectory()) {
                    walk(absEntry, path.posix.join(currentZipPath, entry))
                    continue
                }
                if (!lst.isFile()) {
                    continue
                }
                try {
                    const realPath = fs.realpathSync(absEntry)
                    const relative = path.relative(resolvedRoot, realPath)
                    if (relative.startsWith('..') || path.isAbsolute(relative)) {
                        tl.warning(
                            `Skipping ${absEntry}: resolved path ${realPath} is outside ${resolvedRoot}`
                        )
                        continue
                    }
                } catch (err) {
                    tl.warning(`Skipping ${absEntry}: ${(err as Error).message}`)
                    continue
                }
                zip.addFile(path.posix.join(currentZipPath, entry), fs.readFileSync(absEntry))
            }
        }

        const normalizedPrefix = zipPathPrefix ? zipPathPrefix.replace(/\\/g, '/').replace(/^\/+/, '') : ''
        walk(resolvedRoot, normalizedPrefix)
    }

    public static async prepareAspNetCoreBundleWindows(
        dotnetPublishPath: string,
        tempDirectory: string
    ): Promise<string> {
        const zip = new AdmZip()

        const deploymentBundle = path.join(tempDirectory, 'ebDeploymentBundle.zip')

        console.log(tl.loc('CreatingBeanstalkBundle', deploymentBundle))
        console.log(tl.loc('PublishingPath', dotnetPublishPath))
        const stat = fs.statSync(dotnetPublishPath)
        try {
            if (stat.isFile()) {
                console.log(tl.loc('AddingAspNetCoreBundle', dotnetPublishPath))
                zip.addFile(path.basename(dotnetPublishPath), fs.readFileSync(dotnetPublishPath))
                const manifest = this.generateManifest('./' + path.basename(dotnetPublishPath), '/')
                console.log(tl.loc('AddingManifest'))
                zip.addFile('aws-windows-deployment-manifest.json', Buffer.from(manifest))
            } else {
                console.log(tl.loc('AddingFilesFromDotnetPublish'))
                BeanstalkUtils.addLocalFolderSafe(zip, dotnetPublishPath, '/app/')
                const manifest = this.generateManifest('/app/', '/')
                console.log(tl.loc('AddingManifest'))
                zip.addFile('aws-windows-deployment-manifest.json', Buffer.from(manifest))
            }

            zip.writeZip(deploymentBundle)
        } catch (err) {
            console.log(tl.loc('ZipError', err))
            throw err
        }

        console.log(tl.loc('BundleComplete'))

        return deploymentBundle
    }

    public static async prepareAspNetCoreBundleLinux(
        dotnetPublishPath: string,
        tempDirectory: string
    ): Promise<string> {
        const zip = new AdmZip()

        const deploymentBundle = path.join(tempDirectory, 'ebDeploymentBundle.zip')

        console.log(tl.loc('PublishingPath', dotnetPublishPath))

        const stat = fs.statSync(dotnetPublishPath)
        try {
            if (stat.isFile()) {
                console.log(tl.loc('UsingExistingBeanstalkBundle', dotnetPublishPath))
                return dotnetPublishPath
            } else {
                console.log(tl.loc('CreatingBeanstalkBundle', deploymentBundle))
                BeanstalkUtils.addLocalFolderSafe(zip, dotnetPublishPath)
                zip.writeZip(deploymentBundle)
            }
        } catch (err) {
            console.log(tl.loc('ZipError', err))
            throw err
        }

        console.log(tl.loc('BundleComplete'))

        return deploymentBundle
    }

    public static constructVersionLabel(userVersionLabel: string): string {
        if (userVersionLabel) {
            return userVersionLabel
        }

        return `v${new Date().getTime()}`
    }

    public static generateManifest(appBundle: string, iisPath: string): string {
        const manifest = `{
"manifestVersion": 1,
"deployments": {

"aspNetCoreWeb": [
  {
    "name": "app",
    "parameters": {
      "appBundle": "${appBundle}",

      "iisPath": "${iisPath}",
      "iisWebSite": "Default Web Site"
    }
  }
]
}
}`

        return manifest
    }

    public static async uploadBundle(
        s3Client: S3,
        applicationBundlePath: string,
        bucketName: string,
        objectKey: string
    ): Promise<void> {
        console.log(tl.loc('UploadingBundle', applicationBundlePath, objectKey, bucketName))

        // todo: remove duplicated S3 Upload logic across tasks
        try {
            const readStream = fs.createReadStream(applicationBundlePath)

            readStream.on('error', err => {
                if (err) {
                    throw err
                }
            })

            await s3Client
                .upload({
                    Bucket: bucketName,
                    Key: objectKey,
                    Body: readStream
                })
                .promise()
            console.log(tl.loc('BundleUploadCompleted'))
        } catch (err) {
            console.error(tl.loc('BundleUploadFailed', err))
            throw err
        }
    }

    public static async verifyApplicationExists(
        beanstalkClient: ElasticBeanstalk,
        applicationName: string
    ): Promise<void> {
        let appExists = false

        try {
            const response = await beanstalkClient
                .describeApplications({
                    ApplicationNames: [applicationName]
                })
                .promise()

            if (response.Applications) {
                tl.debug(`Query for application ${applicationName} yield ${response.Applications.length} items`)
                appExists = response.Applications.length === 1
                if (response.Applications.length > 1) {
                    console.log(
                        tl.loc(
                            'ApplicationExistsQueryErrorTooManyApplications',
                            applicationName,
                            response.Applications.join(' ,')
                        )
                    )
                }
            } else {
                tl.debug(`Query for application ${applicationName} had an invalid response ${response}`)
            }
        } catch (err) {
            console.log(tl.loc('ApplicationExistsQueryError', applicationName, err))
        }

        if (!appExists) {
            throw new Error(tl.loc('ApplicationDoesNotExist', applicationName))
        }
    }

    public static async verifyEnvironmentExists(
        beanstalkClient: ElasticBeanstalk,
        applicationName: string,
        environmentName: string
    ): Promise<void> {
        let envExists = false

        try {
            const response = await beanstalkClient
                .describeEnvironments({
                    ApplicationName: applicationName,
                    EnvironmentNames: [environmentName],
                    IncludeDeleted: false
                })
                .promise()

            if (response.Environments) {
                tl.debug(`Query for environment ${environmentName} yielded ${response.Environments.length} items`)
                envExists = response.Environments.length === 1
                if (response.Environments.length > 1) {
                    console.log(
                        tl.loc(
                            'EnvironmentExistsQueryErrorTooManyEnvironments',
                            applicationName,
                            response.Environments.join(' ,')
                        )
                    )
                }
            } else {
                tl.debug(`Query for environment ${environmentName} yielded an invalid response ${response}`)
            }
        } catch (err) {
            console.log(tl.loc('EnvironmentExistsQueryError', applicationName, environmentName, err))
        }

        if (!envExists) {
            throw new Error(tl.loc('EnvironmentDoesNotExist', environmentName, applicationName))
        }
    }
}
