/*!
 * Copyright 2019 Amazon.com, Inc. or its affiliates. All Rights Reserved.
 * SPDX-License-Identifier: MIT
 */

import * as fs from 'fs'
import * as path from 'path'

interface RunnerGenerator {
    taskName: string
    taskClients?: string[]
    additionalImports?: string[]
    additionalArguments?: string[]
    additionalSetupStatements?: string[]
    successResult?: string
    returnType?: string
}

// ---------------------------------------------------------------------------
// Strict validation configuration (CWE-94 defense-in-depth)
// ---------------------------------------------------------------------------
//
// generate.json is a trusted, repo-tracked file, but the generated *.runner.ts
// files are git-ignored and compiled into the shipped .vsix. Every value that
// is interpolated into generated TypeScript source must come from a committed
// allow-list in this file. Adding a new task fragment therefore requires a
// reviewed change to this reviewed TypeScript, not just a JSON edit.

const TASK_NAME_PATTERN = /^[A-Za-z0-9]+$/

// Allowed createDefault<Client> identifiers imported from lib/defaultClients.
const ALLOWED_TASK_CLIENTS: ReadonlySet<string> = new Set([
    'Beanstalk',
    'CloudFormation',
    'CodeDeploy',
    'ECR',
    'IAM',
    'Lambda',
    'S3',
    'SNS',
    'SQS',
    'SSM',
    'SecretsManager',
])

// Allowed return types for the generated run() function.
const ALLOWED_RETURN_TYPES: ReadonlySet<string> = new Set(['void', 'number'])

// Hard-coded allow-lists of code fragments permitted in generate.json.
const ALLOWED_ADDITIONAL_IMPORTS: ReadonlySet<string> = new Set([
    "import { locateDockerExecutable, runDockerCommand } from 'lib/dockerUtils'",
    "import { getCredentials } from 'lib/awsConnectionParameters'",
    "import { getRegion } from 'lib/awsConnectionParameters'",
])

const AWS_EXECUTION_ENV_VAR = 'AWS_EXECUTION_ENV'
const ALLOWED_ADDITIONAL_SETUP_STATEMENTS: ReadonlySet<string> = new Set([
    `process.env.${AWS_EXECUTION_ENV_VAR} = 'VSTS-AWSCLI'`,
    `process.env.${AWS_EXECUTION_ENV_VAR} = 'VSTS-AWSShellScript'`,
    `process.env.${AWS_EXECUTION_ENV_VAR} = 'VSTS-LambdaNETCoreDeploy'`,
])

const ALLOWED_ADDITIONAL_ARGUMENTS: ReadonlySet<string> = new Set([
    '{ runDockerCommand: runDockerCommand, locateDockerExecutable: locateDockerExecutable }',
    'await getCredentials(taskParameters.awsConnectionParameters)',
    "tl.which('dotnet', true)",
    "'dotnet-lambda'",
    'await getRegion()',
])

const repoRoot = path.dirname(__dirname)
const sourceTasks = path.resolve(repoRoot, 'src', 'tasks')

function assertString(value: unknown, context: string): string {
    if (typeof value !== 'string') {
        throw new Error(`generate.json: ${context} must be a string`)
    }
    return value
}

function assertStringArray(value: unknown, context: string): string[] {
    if (!Array.isArray(value)) {
        throw new Error(`generate.json: ${context} must be an array of strings`)
    }
    return value.map((entry, idx) => assertString(entry, `${context}[${idx}]`))
}

function validateFromAllowList(
    values: string[] | undefined,
    allowed: ReadonlySet<string>,
    context: string
): string[] | undefined {
    if (values === undefined) {
        return undefined
    }
    for (const v of values) {
        if (!allowed.has(v)) {
            throw new Error(
                `generate.json: ${context} value is not in the allow-list: ${JSON.stringify(v)}`
            )
        }
    }
    return values
}

function validateEntry(raw: unknown): RunnerGenerator {
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
        throw new Error('generate.json: each entry must be an object')
    }
    const obj = raw as Record<string, unknown>

    const taskName = assertString(obj.taskName, 'taskName')
    if (!TASK_NAME_PATTERN.test(taskName)) {
        throw new Error(
            `generate.json: taskName ${JSON.stringify(taskName)} does not match ${TASK_NAME_PATTERN}`
        )
    }

    // Resolve the output directory and make sure it stays under src/tasks.
    const resolved = path.resolve(sourceTasks, taskName)
    const rel = path.relative(sourceTasks, resolved)
    if (rel.startsWith('..') || path.isAbsolute(rel) || rel === '') {
        throw new Error(
            `generate.json: taskName ${JSON.stringify(taskName)} resolves outside src/tasks`
        )
    }

    const taskClients =
        obj.taskClients === undefined ? undefined : assertStringArray(obj.taskClients, 'taskClients')
    if (taskClients !== undefined) {
        for (const c of taskClients) {
            if (!ALLOWED_TASK_CLIENTS.has(c)) {
                throw new Error(
                    `generate.json: taskClients entry ${JSON.stringify(c)} is not in the allow-list`
                )
            }
        }
    }

    const additionalImports = validateFromAllowList(
        obj.additionalImports === undefined
            ? undefined
            : assertStringArray(obj.additionalImports, 'additionalImports'),
        ALLOWED_ADDITIONAL_IMPORTS,
        'additionalImports'
    )

    const additionalSetupStatements = validateFromAllowList(
        obj.additionalSetupStatements === undefined
            ? undefined
            : assertStringArray(obj.additionalSetupStatements, 'additionalSetupStatements'),
        ALLOWED_ADDITIONAL_SETUP_STATEMENTS,
        'additionalSetupStatements'
    )

    const additionalArguments = validateFromAllowList(
        obj.additionalArguments === undefined
            ? undefined
            : assertStringArray(obj.additionalArguments, 'additionalArguments'),
        ALLOWED_ADDITIONAL_ARGUMENTS,
        'additionalArguments'
    )

    const returnType = obj.returnType === undefined ? undefined : assertString(obj.returnType, 'returnType')
    if (returnType !== undefined && !ALLOWED_RETURN_TYPES.has(returnType)) {
        throw new Error(
            `generate.json: returnType ${JSON.stringify(returnType)} is not in the allow-list`
        )
    }

    const successResult =
        obj.successResult === undefined ? undefined : assertString(obj.successResult, 'successResult')

    return {
        taskName,
        taskClients,
        additionalImports,
        additionalArguments,
        additionalSetupStatements,
        successResult,
        returnType,
    }
}

const header = `
/*!
 * Copyright 2019 Amazon.com, Inc. or its affiliates. All Rights Reserved.
 * SPDX-License-Identifier: MIT
 */

/* NOTE! this file is auto-generated by generateRunners.ts, do not edit it by hand or commit it */
`

function generate(
    filename: string,
    clientTypes: string[] | undefined,
    additionalArguments?: string[],
    additionalImports?: string[],
    additionalSetupStatements?: string[],
    successResult?: string,
    returnType?: string
) {
    const importStament = `
import * as tl from 'azure-pipelines-task-lib/task'

import { SdkUtils } from 'lib/sdkutils'
import { warnIfBuildAgentTooLow } from 'lib/vstsUtils'
${
    clientTypes === undefined
        ? ''
        : `\nimport { ${clientTypes.map(it => 'createDefault' + it).join(', ')} } from 'lib/defaultClients'`
}
import { TaskOperations } from './TaskOperations'
import { buildTaskParameters } from './TaskParameters'${
        additionalImports === undefined ? '' : '\n\n' + additionalImports.join('\n        ')
    }
`

    const runStatement = `
async function run(): Promise<${returnType === undefined ? 'void' : returnType}> {
    SdkUtils.readResources()${
        additionalSetupStatements === undefined ? '' : '\n    ' + additionalSetupStatements.join('\n    ')
    }
    const taskParameters = buildTaskParameters()

    return new TaskOperations(${
        clientTypes === undefined
            ? ''
            : '\n        ' +
              clientTypes
                  .map(it => {
                      // tslint:disable-next-line:prefer-template
                      return 'await createDefault' + it + '(taskParameters, tl.debug),'
                  })
                  .join('\n        ')
    }${
        // tslint:disable-next-line:prefer-template
        additionalArguments === undefined ? '' : '\n        ' + additionalArguments.join(',\n        ') + ','
    }
        taskParameters).execute()
}
`

    // TODO: Optionally output "TaskResult.SucceededWithIssues" depending on result?
    const run = `
run().then((result) => {
    tl.setResult(tl.TaskResult.Succeeded, '')
}).catch((error) => {
    tl.setResult(tl.TaskResult.Failed, \`\${error}\`)
})
`

    const output = header + importStament + runStatement + run

    // taskName has already been validated against TASK_NAME_PATTERN and the
    // resolved path confirmed to stay under src/tasks; recompute the final
    // path with path.join (not string interpolation) and re-check containment
    // so there is a single, auditable call-site for the write.
    const outputDir = path.join(sourceTasks, filename)
    const outputFile = path.join(outputDir, `${filename}.runner.ts`)
    const outputFileRel = path.relative(sourceTasks, outputFile)
    if (outputFileRel.startsWith('..') || path.isAbsolute(outputFileRel)) {
        throw new Error(`refusing to write generated runner outside src/tasks: ${outputFile}`)
    }
    fs.writeFileSync(outputFile, output)
}

const generateFile = path.join(repoRoot, 'generate.json')
const rawJson = JSON.parse(fs.readFileSync(generateFile).toString())
if (!Array.isArray(rawJson)) {
    throw new Error('generate.json: top-level value must be an array')
}
const parsedJson: RunnerGenerator[] = rawJson.map(validateEntry)
for (const json of parsedJson) {
    generate(
        json.taskName,
        json.taskClients,
        json.additionalArguments,
        json.additionalImports,
        json.additionalSetupStatements,
        json.successResult,
        json.returnType
    )
}
