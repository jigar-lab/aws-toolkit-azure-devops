/*!
 * Copyright 2019 Amazon.com, Inc. or its affiliates. All Rights Reserved.
 * SPDX-License-Identifier: MIT
 */

import ncp = require('child_process')
import crypto = require('crypto')
import esbuild = require('esbuild')
import fs = require('fs-extra')
import path = require('path')
import folders = require('./scriptUtils')
import os = require('os')

const timeMessage = 'Packaged extension'
const manifestFile = 'vss-extension.json'

const ignoredFolders = ['Common', '.DS_Store']

const vstsFiles = ['task.json', 'task.loc.json', 'package.json', 'icon.png', 'Strings']

interface CommandLineOptions {
    publisher?: string
}

/**
 * Patch shelljs, because it is not compatible with esbuild
 * More info: https://github.com/aws/aws-toolkit-azure-devops/pull/539
 *
 * NOTE: in-place mutation of node_modules is a stopgap. The target path is
 * anchored to `folders.repoRoot` (not `process.cwd()`), process-level signal
 * and exit handlers are wired so an interrupted build still restores the
 * original bytes, and after `unpatch()` the restored file's SHA-256 is
 * compared to the pre-patch hash so a half-restored dependency surfaces as a
 * build failure instead of silently leaking into later runs.
 */
class ShelljsPatch {
    private static readonly shelljsRootPath = path.resolve(folders.repoRoot, 'node_modules', 'shelljs')
    private static readonly shelljsEntryPath = path.join(ShelljsPatch.shelljsRootPath, 'shell.js')

    private originalContent: string | undefined
    private originalHash: string | undefined

    private static sha256(content: string): string {
        return crypto.createHash('sha256').update(content, 'utf-8').digest('hex')
    }

    patch() {
        const sourceRequireString =
            "require('./commands').forEach(function (command) {\n  require('./src/' + command);\n});"
        const originalContent = fs.readFileSync(ShelljsPatch.shelljsEntryPath, 'utf-8')

        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const fixedRequireString = require(path.join(ShelljsPatch.shelljsRootPath, 'commands.js'))
            .map((command: string) => `require('./src/${command}.js');`)
            .join('\n')

        const patchedContent = originalContent.replace(sourceRequireString, fixedRequireString)
        if (originalContent === patchedContent) {
            throw new Error('Could not patch shelljs, was this npm package updated?')
        }

        fs.writeFileSync(ShelljsPatch.shelljsEntryPath, patchedContent)

        this.originalContent = originalContent
        this.originalHash = ShelljsPatch.sha256(originalContent)
    }

    unpatch() {
        if (this.originalContent) {
            fs.writeFileSync(ShelljsPatch.shelljsEntryPath, this.originalContent)
            this.originalContent = undefined
        }
    }

    /**
     * Verify that the file on disk matches the SHA-256 recorded before patching.
     * Should be called after `unpatch()` on a successful build. Throws if the
     * restored bytes do not match, so a corrupted workspace cannot be mistaken
     * for a clean one.
     */
    verifyRestored() {
        if (!this.originalHash) {
            return
        }
        const currentContent = fs.readFileSync(ShelljsPatch.shelljsEntryPath, 'utf-8')
        const currentHash = ShelljsPatch.sha256(currentContent)
        if (currentHash !== this.originalHash) {
            throw new Error(
                `shelljs/shell.js was not restored to its pre-patch content (expected sha256 ${this.originalHash}, got ${currentHash}). Run 'npm ci' to restore the verified bytes.`
            )
        }
        this.originalHash = undefined
    }
}
const shelljsPatch = new ShelljsPatch()

// Ensure an interrupted build (SIGINT/SIGTERM, uncaught exception, or any
// normal/abnormal exit) does not leave node_modules/shelljs/shell.js mutated
// in the workspace, where every later `npm run package`, `npm test` and `jest`
// run would consume it.
let cleanupRan = false
function cleanupShelljsPatch() {
    if (cleanupRan) {
        return
    }
    cleanupRan = true
    try {
        shelljsPatch.unpatch()
    } catch (err) {
        // Best-effort: a failure here must not shadow the original signal/exit.
        console.error('Failed to restore node_modules/shelljs/shell.js:', err)
    }
}
process.on('exit', cleanupShelljsPatch)
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGBREAK'] as NodeJS.Signals[]) {
    process.on(signal, () => {
        cleanupShelljsPatch()
        // Re-raise with the conventional 128+signal exit code so the parent
        // process sees the interruption rather than a clean exit.
        const signalNumbers: Record<string, number> = { SIGINT: 2, SIGTERM: 15, SIGHUP: 1, SIGBREAK: 21 }
        process.exit(128 + (signalNumbers[signal] || 0))
    })
}

function findMatchingFiles(directory: string) {
    return fs.readdirSync(directory)
}

function installNodePackages(directory: string) {
    fs.mkdirpSync(directory)
    const npmCmd = `npm install --prefix ${directory} azure-pipelines-task-lib --only=production`
    const output = ncp.execSync(npmCmd)
    console.log(output.toString('utf8'))
}

function generateGitHashFile() {
    try {
        const response = ncp.execSync('git rev-parse HEAD', { encoding: 'utf-8' }).toString()
        console.log(`Putting git hash ${response.trim()} into the package directory`)
        fs.outputFileSync(path.join(folders.packageRoot, '.gitcommit'), response.trim())
    } catch (e) {
        console.log(`Getting commit hash failed ${e}`)
        throw e
    }
}

function packagePlugin(options: CommandLineOptions) {
    fs.mkdirpSync(folders.packageRoot)
    fs.mkdirpSync(folders.packageTasks)
    const npmFolder = path.join(folders.buildRoot, 'npmcache')

    fs.copySync(path.join(folders.repoRoot, 'LICENSE'), path.join(folders.packageRoot, 'LICENSE'), { overwrite: true })
    fs.copySync(path.join(folders.repoRoot, 'README.md'), path.join(folders.packageRoot, 'README.md'), {
        overwrite: true
    })
    fs.copySync(path.join(folders.repoRoot, 'build', manifestFile), path.join(folders.packageRoot, manifestFile), {
        overwrite: true
    })

    generateGitHashFile()

    // stage manifest images
    fs.copySync(path.join(folders.repoRoot, 'images'), path.join(folders.packageRoot, 'images'), { overwrite: true })

    // get required npm packages that will be copied
    installNodePackages(npmFolder)

    shelljsPatch.patch()

    // clean, dedupe and pack each task as needed
    findMatchingFiles(folders.sourceTasks).forEach(function(taskName) {
        console.log('Processing task ' + taskName)

        if (ignoredFolders.some(folderName => folderName === taskName)) {
            console.log('Skpping task ' + taskName)

            return
        }

        const taskBuildFolder = path.join(folders.buildTasks, taskName)
        const taskPackageFolder = path.join(folders.packageTasks, taskName)
        fs.mkdirpSync(taskPackageFolder)

        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const taskDef = require(path.join(taskBuildFolder, 'task.json'))
        if (
            !Object.hasOwnProperty.call(taskDef.execution, 'Node') &&
            !Object.hasOwnProperty.call(taskDef.execution, 'Node10') &&
            !Object.hasOwnProperty.call(taskDef.execution, 'Node14')
        ) {
            console.log('Copying non-node task ' + taskName)
            fs.copySync(taskBuildFolder, taskPackageFolder)

            return
        }

        for (const resourceFile of vstsFiles) {
            fs.copySync(path.join(taskBuildFolder, resourceFile), path.join(taskPackageFolder, resourceFile), {
                overwrite: true
            })
        }
        // we also need lib.json from azure pipelines task lib or else localization will not work properly
        fs.copySync(
            path.join(folders.repoRoot, 'node_modules/azure-pipelines-task-lib/lib.json'),
            path.join(taskPackageFolder, 'lib.json'),
            { overwrite: true }
        )

        const inputFilename = path.join(taskBuildFolder, taskName + '.runner.js')

        console.log('packing node-based task')
        const result = esbuild.buildSync({
            entryPoints: [inputFilename],
            bundle: true,
            platform: 'node',
            target: ['node10'],
            minify: true,
            outfile: `${taskPackageFolder}/${taskName}.js`
        })
        result.warnings.forEach(warning => console.log(warning))
    })

    shelljsPatch.unpatch()
    shelljsPatch.verifyRestored()

    console.log('Creating deployment vsix')

    const binName = os.platform() === 'win32' ? `tfx.cmd` : 'tfx'
    const tfx = path.join(process.cwd(), 'node_modules', '.bin', binName)
    const args: string[] = ['extension', 'create', '--root', folders.packageRoot]

    args.push('--output-path', folders.packageRoot)
    args.push('--manifests', path.join(folders.packageRoot, manifestFile))

    if (options.publisher) {
        args.push('--publisher', options.publisher)
    }

    console.log('Packaging with:' + `${tfx} ${args.join(' ')}`)

    ncp.execFileSync(tfx, args, {
        stdio: 'inherit',
        shell: os.platform() === 'win32' // for tfx.cmd on Windows.
    })

    console.log('Packaging successful')
}

console.time(timeMessage)
const commandLineInput = process.argv.slice(2) ?? ''
const parsedOptions: CommandLineOptions = {}
if (commandLineInput.length > 0 && commandLineInput[0].split('=')[0] === 'publisher') {
    parsedOptions.publisher = commandLineInput[0].split('=')[1]
}

try {
    packagePlugin(parsedOptions)
} catch (e) {
    shelljsPatch.unpatch()
    shelljsPatch.verifyRestored()
    throw e
}

console.timeEnd(timeMessage)
