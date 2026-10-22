/*!
 * Copyright 2019 Amazon.com, Inc. or its affiliates. All Rights Reserved.
 * SPDX-License-Identifier: MIT
 */

import { debug, loc, mkdirP, tool, which } from 'azure-pipelines-task-lib/task'
import { IExecOptions } from 'azure-pipelines-task-lib/toolrunner'
import { getCredentials, getRegion } from 'lib/awsConnectionParameters'
import { SdkUtils } from 'lib/sdkutils'
import * as fs from 'fs'
import { mkdtempSync, writeFileSync } from 'fs'
import { basename, dirname, join, posix } from 'path'
import { inlineScriptType, TaskParameters } from './TaskParameters'

export class TaskOperations {
    public constructor(public readonly taskParameters: TaskParameters) {}

    // based on the VSTS 'ShellScript' task but modified to inject AWS credentials
    // and region into the environment, and to be able to specify the script inline
    // or from a file
    public async execute(): Promise<number> {
        let scriptPath = ''
        let scriptTempDir = ''
        try {
            await this.configureAWSContext()
            await SdkUtils.configureHttpProxyFromAgentProxyConfiguration('AWSShellScript')

            const bash = tool(which('bash', true))

            if (this.taskParameters.scriptType === inlineScriptType) {
                const tempRoot = SdkUtils.getTempLocation()
                // Create an unguessable, 0700-mode directory inside the temp root and
                // write the inline script there with exclusive-create (O_EXCL via 'wx')
                // and 0600 permissions. This prevents pre-created-file / symlink TOCTOU
                // attacks and keeps the script contents unreadable to other local users.
                scriptTempDir = mkdtempSync(join(tempRoot, 'awsshellscript-'))
                try {
                    fs.chmodSync(scriptTempDir, 0o700)
                } catch {
                    // best-effort; mkdtempSync already restricts via umask on POSIX
                }
                const fileName = `awsshellscript_${process.pid}.sh`
                scriptPath = join(scriptTempDir, fileName)
                writeFileSync(scriptPath, this.taskParameters.inlineScript, {
                    encoding: 'utf-8',
                    mode: 0o600,
                    flag: 'wx'
                })
            } else {
                scriptPath = this.taskParameters.filePath
            }

            let workingDirectory: string
            if (this.taskParameters.disableAutoCwd) {
                workingDirectory = this.taskParameters.workingDirectory
            } else {
                workingDirectory = process.env.SYSTEM_DEFAULTWORKINGDIRECTORY || dirname(scriptPath)
            }

            // The solution to this not working on windows comes from doing it like it's done in
            // the ms task: https://github.com/microsoft/azure-pipelines-tasks/blob/master/Tasks/BashV3/bash.ts
            // Thanks to the ms team opensourcing their tasks for the solution logic
            if (process.platform === 'win32') {
                scriptPath =
                    (await this.translateWindowsPath(dirname(scriptPath))) + `${posix.sep}${basename(scriptPath)}`
            }

            mkdirP(workingDirectory)

            bash.arg(scriptPath)

            if (this.taskParameters.arguments) {
                bash.line(this.taskParameters.arguments)
            }

            const execOptions = {
                cwd: workingDirectory,
                env: process.env,
                errStream: process.stdout,
                outStream: process.stdout,
                failOnStdErr: this.taskParameters.failOnStandardError
            }

            return await bash.exec((execOptions as unknown) as IExecOptions)
        } finally {
            if (this.taskParameters.scriptType === inlineScriptType && scriptTempDir) {
                TaskOperations.removeDirectoryRecursive(scriptTempDir)
            }
        }
    }

    // Recursively remove a directory. Equivalent to `rm -rf` but works on the Node 10
    // baseline declared in package.json (fs.rmSync / fs.rmdirSync({recursive:true})
    // were only added later). Uses lstat so symlinks are unlinked rather than followed.
    private static removeDirectoryRecursive(target: string): void {
        let stat: fs.Stats
        try {
            stat = fs.lstatSync(target)
        } catch {
            return
        }
        if (!stat.isDirectory()) {
            try {
                fs.unlinkSync(target)
            } catch {
                /* ignore */
            }
            return
        }
        let entries: string[] = []
        try {
            entries = fs.readdirSync(target)
        } catch {
            /* ignore */
        }
        for (const entry of entries) {
            const entryPath = join(target, entry)
            let entryStat: fs.Stats
            try {
                entryStat = fs.lstatSync(entryPath)
            } catch {
                continue
            }
            if (entryStat.isDirectory()) {
                TaskOperations.removeDirectoryRecursive(entryPath)
            } else {
                try {
                    fs.unlinkSync(entryPath)
                } catch {
                    /* ignore */
                }
            }
        }
        try {
            fs.rmdirSync(target)
        } catch {
            /* ignore */
        }
    }

    private async translateWindowsPath(windowsPath: string): Promise<string> {
        const pwd = tool(which('bash', true))
            .arg('--noprofile')
            .arg('--norc')
            .arg('-c')
            .arg('pwd')

        const options = {
            cwd: windowsPath,
            errStream: process.stdout,
            outStream: process.stdout,
            failOnStdErr: true,
            ignoreReturnCode: false
        }
        let unixPath = ''
        pwd.on('stdout', (c: string | symbol) => (unixPath += c.toString()))
        await pwd.exec((options as unknown) as IExecOptions)
        unixPath = unixPath.trim()

        if (!unixPath) {
            throw new Error(loc('BashUnableToFindScript', windowsPath))
        }

        return unixPath
    }

    // If assume role credentials are in play, make sure the initial generation
    // of temporary credentials has been performed. If no credentials and/or
    // region were defined then we assume they are already set in the host
    // environment. Environment variables are preferred over stored profiles
    // as this isolates parallel builds and avoids content left lying around on
    // the agent when a build completes
    private async configureAWSContext() {
        const env = process.env

        const credentials = await getCredentials(this.taskParameters.awsConnectionParameters)
        if (credentials) {
            await credentials.getPromise()
            debug('configure credentials into environment variables')
            env.AWS_ACCESS_KEY_ID = credentials.accessKeyId
            env.AWS_SECRET_ACCESS_KEY = credentials.secretAccessKey
            if (credentials.sessionToken) {
                env.AWS_SESSION_TOKEN = credentials.sessionToken
            }
        }

        const region = await getRegion()
        if (region) {
            debug('configure region into environment variable')
            env.AWS_REGION = region
            // set for the benefit of any aws cli commands the user might
            // exec as part of the script
            env.AWS_DEFAULT_REGION = region
        }
    }
}
