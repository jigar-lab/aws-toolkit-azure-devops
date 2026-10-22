/*!
 * Copyright 2019 Amazon.com, Inc. or its affiliates. All Rights Reserved.
 * SPDX-License-Identifier: MIT
 */

import ncp = require('child_process')
import esbuild = require('esbuild')
import fs = require('fs-extra')
import path = require('path')
import folders = require('./scriptUtils')
import os = require('os')
import { allowedNonNodeTaskFiles, verifyPsModules } from './verifyPsModules'

const timeMessage = 'Packaged extension'
const manifestFile = 'vss-extension.json'

const ignoredFolders = ['Common', '.DS_Store']

const vstsFiles = ['task.json', 'task.loc.json', 'package.json', 'icon.png', 'Strings']

// Known VSTS/Azure Pipelines task handler names. Any task.json whose
// `execution` section lists one of these keys drives a specific packaging
// branch below. The list is deliberately explicit so that newly introduced
// handlers cause packaging to fail loudly instead of silently falling back
// to a raw directory copy that would ship an unbundled task.
const knownNodeHandlers = ['Node', 'Node10', 'Node14', 'Node16', 'Node20', 'Node20_1'] as const
const knownNonNodeHandlers = ['PowerShell3'] as const
const knownHandlers: readonly string[] = [...knownNodeHandlers, ...knownNonNodeHandlers]

// Per non-Node task packaging allow-list. Each entry is a path (POSIX
// separators) relative to the task's build folder. Only files on this list
// are copied into the staged .vsix for that task; everything else - including
// unexpected additions under ps_modules - is refused. The ps_modules files
// are pulled from the integrity-pinned manifest so this allow-list cannot
// drift from the SHA-256 pins in build-scripts/psModulesManifest.json.
function nonNodeTaskAllowList(taskName: string): string[] {
    const perTaskExtras: Record<string, string[]> = {
        AWSPowerShellModuleScript: [
            'task.json',
            'task.loc.json',
            'icon.png',
            'RunAWSPowerShellModuleScript.ps1',
            'Strings/resources.resjson/en-US/resources.resjson'
        ]
    }
    const extras = perTaskExtras[taskName]
    if (!extras) {
        throw new Error(
            'No non-Node packaging allow-list is defined for task ' +
                taskName +
                '. Add an explicit file list (and, for any vendored binaries, a SHA-256 entry in build-scripts/psModulesManifest.json) before packaging it.'
        )
    }
    return [...extras, ...allowedNonNodeTaskFiles(taskName)]
}

// Files that are allowed to be missing from a non-Node task's build output.
// Everything else on the allow-list must exist (so a typo in the allow-list
// or a missing resource is caught by the build).
const optionalNonNodeFiles = new Set(['task.loc.json', 'Strings/resources.resjson/en-US/resources.resjson'])

function copyAllowList(sourceDir: string, destDir: string, relFiles: string[]): void {
    for (const rel of relFiles) {
        const src = path.join(sourceDir, ...rel.split('/'))
        if (!fs.existsSync(src)) {
            if (optionalNonNodeFiles.has(rel)) {
                continue
            }
            throw new Error('Allow-listed file ' + rel + ' is missing from ' + sourceDir)
        }
        const dest = path.join(destDir, ...rel.split('/'))
        fs.mkdirpSync(path.dirname(dest))
        fs.copySync(src, dest, { overwrite: true })
    }
}

interface CommandLineOptions {
    publisher?: string
}

/**
 * Patch shelljs, because it is not compatible with esbuild
 * More info: https://github.com/aws/aws-toolkit-azure-devops/pull/539
 */
class ShelljsPatch {
    private static readonly shelljsRootPath = path.resolve(process.cwd(), './node_modules/shelljs/')
    private static readonly shelljsEntryPath = path.join(ShelljsPatch.shelljsRootPath, 'shell.js')

    private originalContent: string | undefined

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
    }

    unpatch() {
        if (this.originalContent) {
            fs.writeFileSync(ShelljsPatch.shelljsEntryPath, this.originalContent)
            this.originalContent = undefined
        }
    }
}
const shelljsPatch = new ShelljsPatch()

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
    // Fail the package step before anything is copied if a vendored binary
    // has been changed without a matching entry in psModulesManifest.json.
    verifyPsModules()

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
        const declaredHandlers = Object.keys(taskDef.execution ?? {})
        if (declaredHandlers.length === 0) {
            throw new Error('Task ' + taskName + ' has no execution handlers declared in task.json')
        }
        const unknownHandlers = declaredHandlers.filter(h => !knownHandlers.includes(h))
        if (unknownHandlers.length > 0) {
            // Fail loudly rather than silently falling back to a raw directory
            // copy: an unknown handler means we do not know whether this task
            // should be bundled with esbuild, hash-pinned under ps_modules, or
            // packaged some other way, and shipping it unverified would be a
            // supply-chain regression.
            throw new Error(
                'Task ' +
                    taskName +
                    ' declares unknown execution handler(s): ' +
                    unknownHandlers.join(', ') +
                    '. Update build-scripts/packageExtension.ts (knownNodeHandlers / knownNonNodeHandlers) to add a packaging branch for the new handler before this task can be packaged.'
            )
        }
        const hasNodeHandler = declaredHandlers.some(h => (knownNodeHandlers as readonly string[]).includes(h))
        if (!hasNodeHandler) {
            console.log('Copying non-node task ' + taskName + ' using an explicit allow-list')
            copyAllowList(taskBuildFolder, taskPackageFolder, nonNodeTaskAllowList(taskName))

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
    throw e
}

console.timeEnd(timeMessage)
