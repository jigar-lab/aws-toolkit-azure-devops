/*!
 * Copyright 2019 Amazon.com, Inc. or its affiliates. All Rights Reserved.
 * SPDX-License-Identifier: MIT
 *
 * Integrity gate for vendored prebuilt third-party binaries under
 * src/tasks/**\/ps_modules. The source of truth is
 * build-scripts/psModulesManifest.json which pins every file by SHA-256.
 *
 * Rationale: the extension vendors Microsoft's VstsTaskSdk PowerShell SDK,
 * which includes two .NET assemblies (VstsTaskSdk.dll, Minimatch.dll) that
 * the vendored VstsTaskSdk.psm1 loads with Add-Type on every Windows
 * build agent. Without a build-time integrity check, a tampered commit
 * could substitute those binaries and have them loaded into a process
 * that holds pipeline AWS credentials.
 *
 * This verifier runs before packaging. If it fails, the package step must
 * abort rather than silently shipping unverified binaries.
 */

import * as crypto from 'crypto'
import * as fs from 'fs'
import * as ncp from 'child_process'
import * as os from 'os'
import * as path from 'path'
import * as folders from './scriptUtils'

interface AuthenticodeSpec {
    comment?: string
    expectedSubject: string
    assemblies: string[]
}

interface ModuleManifest {
    upstream?: { name?: string; repository?: string; notes?: string }
    files: Record<string, string>
    authenticodeSignatures?: AuthenticodeSpec
}

interface Manifest {
    comment?: string
    modules: Record<string, ModuleManifest>
}

export const manifestPath = path.join(__dirname, 'psModulesManifest.json')

export function loadManifest(manifestFile: string = manifestPath): Manifest {
    const raw = fs.readFileSync(manifestFile, 'utf8')
    const parsed = JSON.parse(raw) as Manifest
    if (!parsed || typeof parsed !== 'object' || !parsed.modules) {
        throw new Error('ps_modules manifest is missing a modules map: ' + manifestFile)
    }
    return parsed
}

function sha256(file: string): string {
    const hash = crypto.createHash('sha256')
    hash.update(fs.readFileSync(file))
    return hash.digest('hex')
}

function listFilesRecursively(dir: string, base = dir): string[] {
    const out: string[] = []
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name)
        if (entry.isDirectory()) {
            out.push(...listFilesRecursively(full, base))
        } else if (entry.isFile()) {
            out.push(path.relative(base, full).split(path.sep).join('/'))
        } else {
            throw new Error('Unsupported entry type under ps_modules: ' + full)
        }
    }
    return out
}

const authenticodeScript = [
    '$ErrorActionPreference = "Stop"',
    '$sig = Get-AuthenticodeSignature -LiteralPath $env:PSM_ASSEMBLY_PATH',
    'if ($sig.Status -ne "Valid") { Write-Error ("Authenticode status: " + $sig.Status); exit 2 }',
    'Write-Output $sig.SignerCertificate.Subject'
].join('; ')

function verifyAuthenticode(moduleDir: string, spec: AuthenticodeSpec): string[] {
    const errors: string[] = []
    if (os.platform() !== 'win32') {
        console.log(
            '  [skip] Authenticode verification requires Windows; running on ' +
                os.platform() +
                '. SHA-256 pinning still applies to ' +
                spec.assemblies.join(', ')
        )
        return errors
    }

    for (const assembly of spec.assemblies) {
        const assemblyPath = path.join(moduleDir, assembly)
        try {
            const output = ncp
                .execFileSync(
                    'powershell.exe',
                    ['-NoProfile', '-NonInteractive', '-Command', authenticodeScript],
                    {
                        env: { ...process.env, PSM_ASSEMBLY_PATH: assemblyPath },
                        encoding: 'utf8'
                    }
                )
                .trim()
            if (!output.includes(spec.expectedSubject)) {
                errors.push(
                    assemblyPath +
                        ': Authenticode subject ' +
                        JSON.stringify(output) +
                        ' does not match expected ' +
                        JSON.stringify(spec.expectedSubject)
                )
            } else {
                console.log('  [ok]   Authenticode ' + assembly + ': ' + output)
            }
        } catch (e) {
            errors.push(assemblyPath + ': Authenticode verification failed: ' + (e as Error).message)
        }
    }
    return errors
}

/**
 * Verify every file under each ps_modules path listed in the manifest:
 *   1. the set of files on disk must exactly match the manifest
 *      (no extras, none missing)
 *   2. each file's SHA-256 must match the pinned value
 *   3. on Windows, the listed .NET assemblies must carry an Authenticode
 *      signature whose subject matches the expected publisher
 *
 * Throws on any failure so the caller aborts packaging.
 */
export function verifyPsModules(repoRoot: string = folders.repoRoot, manifestFile?: string): void {
    const manifest = loadManifest(manifestFile)
    const allErrors: string[] = []

    for (const [relModuleDir, moduleManifest] of Object.entries(manifest.modules)) {
        const moduleDir = path.join(repoRoot, relModuleDir)
        console.log('Verifying vendored ps_module: ' + relModuleDir)

        if (!fs.existsSync(moduleDir) || !fs.statSync(moduleDir).isDirectory()) {
            allErrors.push(relModuleDir + ': directory not found at ' + moduleDir)
            continue
        }

        const onDisk = new Set(listFilesRecursively(moduleDir))
        const inManifest = new Set(Object.keys(moduleManifest.files))

        for (const relFile of onDisk) {
            if (!inManifest.has(relFile)) {
                allErrors.push(relModuleDir + '/' + relFile + ': present on disk but not pinned in manifest')
            }
        }
        for (const relFile of inManifest) {
            if (!onDisk.has(relFile)) {
                allErrors.push(relModuleDir + '/' + relFile + ': pinned in manifest but missing on disk')
                continue
            }
            const actual = sha256(path.join(moduleDir, relFile))
            const expected = moduleManifest.files[relFile]
            if (actual.toLowerCase() !== expected.toLowerCase()) {
                allErrors.push(
                    relModuleDir +
                        '/' +
                        relFile +
                        ': sha256 mismatch (expected ' +
                        expected +
                        ', actual ' +
                        actual +
                        ')'
                )
            } else {
                console.log('  [ok]   sha256 ' + relFile)
            }
        }

        if (moduleManifest.authenticodeSignatures) {
            allErrors.push(...verifyAuthenticode(moduleDir, moduleManifest.authenticodeSignatures))
        }
    }

    if (allErrors.length > 0) {
        const message =
            'ps_modules integrity verification failed:\n  - ' +
            allErrors.join('\n  - ') +
            '\nIf this change is intentional, update build-scripts/psModulesManifest.json ' +
            'with the new SHA-256 hashes and record the upstream source ' +
            '(version + commit) that produced the new binaries.'
        throw new Error(message)
    }

    console.log('ps_modules integrity verification: OK')
}

/**
 * List of per-task relative file paths that are allowed to be shipped in the
 * .vsix for each non-Node task. Keyed by task name. Entries beginning with a
 * module directory are expanded from the integrity manifest so that the
 * allow-list and the hash-pinned manifest cannot drift.
 */
export function allowedNonNodeTaskFiles(taskName: string, manifestFile?: string): string[] {
    const manifest = loadManifest(manifestFile)
    const prefix = 'src/tasks/' + taskName + '/'
    const files: string[] = []
    for (const [relModuleDir, moduleManifest] of Object.entries(manifest.modules)) {
        if (!relModuleDir.startsWith(prefix)) {
            continue
        }
        const relToTask = relModuleDir.slice(prefix.length)
        for (const relFile of Object.keys(moduleManifest.files)) {
            files.push(relToTask + '/' + relFile)
        }
    }
    return files
}

if (require.main === module) {
    try {
        verifyPsModules()
    } catch (e) {
        console.error((e as Error).message)
        process.exit(1)
    }
}
