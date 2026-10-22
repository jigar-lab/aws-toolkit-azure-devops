/*!
 * Copyright 2019 Amazon.com, Inc. or its affiliates. All Rights Reserved.
 * SPDX-License-Identifier: MIT
 */

import tl = require('azure-pipelines-task-lib/task')

export const transformCustom = 'custom'
export const transformSubstitute = 'substitute'
export const readModeSingle = 'single'
export const readModeHierarchy = 'hierarchy'

// Names derived from remote SSM parameter names are used verbatim as Azure Pipelines
// variable names, which the agent exposes to subsequent steps as process environment
// variables. To prevent an actor with ssm:PutParameter on the configured path from
// poisoning the agent environment (e.g. by naming a parameter leaf `NODE_OPTIONS` or
// `LD_PRELOAD`), the SystemsManagerGetParameter sink validates the derived name against
// a conservative character set and rejects names that collide with process-control or
// agent-reserved variables. This helper centralises that policy.
const ssmVariableNamePattern = /^[A-Za-z_][A-Za-z0-9_]*$/
const reservedVariableNames = new Set(
    [
        'PATH',
        'NODE_OPTIONS',
        'LD_PRELOAD',
        'LD_LIBRARY_PATH',
        'DYLD_INSERT_LIBRARIES',
        'DYLD_LIBRARY_PATH',
        'PYTHONPATH',
        'PYTHONSTARTUP',
        'CLASSPATH'
    ].map(n => n.toUpperCase())
)
const reservedVariablePrefixes = ['AWS_', 'AGENT_', 'SYSTEM_', 'BUILD_', 'TASK_', 'COMMON_']

export function isReservedVariableName(name: string): boolean {
    const upper = name.toUpperCase()
    if (reservedVariableNames.has(upper)) {
        return true
    }
    return reservedVariablePrefixes.some(prefix => upper.startsWith(prefix))
}

// Returns true if the supplied name is a syntactically-valid SSM-derived variable name
// and does not collide with a process-control or agent-reserved variable. The check is
// applied only to names derived from remote data (readModeHierarchy and the `substitute`
// transform); names typed directly by the pipeline author (`custom`, and the explicit
// `parameterName` input used by `readModeSingle` + `none`) are trusted and intentionally
// excluded from this check so author-chosen names are not silently rejected.
export function isSafeSsmVariableName(name: string): boolean {
    return ssmVariableNamePattern.test(name) && !isReservedVariableName(name)
}

// Transforms the read parameter name depending on task settings. If the task was set
// to read a single parameter, the input parameter name is in the task parameters. When
// reading a hierarchy, we pass in the individual parameter name from the collection
// read by the task.
export function transformParameterToVariableName(
    taskParameters: {
        parameterName: string
        variableNameTransform: string
        globalMatch: boolean
        caseInsensitiveMatch: boolean
        replacementPattern: string
        replacementText: string
        customVariableName: string
    },
    inputParameterName?: string
): string {
    if (inputParameterName === undefined) {
        inputParameterName = taskParameters.parameterName
    }

    let outputVariableName: string | undefined
    switch (taskParameters.variableNameTransform) {
        case 'none':
            outputVariableName = inputParameterName
            break

        case 'leaf':
            const parts = inputParameterName.split(/\//)
            // if the name ended in /, walk backwards
            for (let i: number = parts.length - 1; i > 0; i--) {
                if (parts[i]) {
                    outputVariableName = parts[i]
                    break
                }
            }

            if (!outputVariableName) {
                throw new Error(`Failed to determine leaf component of parameter name ${taskParameters.parameterName}`)
            }
            break

        case 'substitute':
            let flags = ''
            if (taskParameters.globalMatch) {
                flags += 'g'
            }
            if (taskParameters.caseInsensitiveMatch) {
                flags += 'i'
            }
            const pattern = new RegExp(taskParameters.replacementPattern, flags)
            outputVariableName = inputParameterName.replace(pattern, taskParameters.replacementText)
            break

        // note this mode is only applicable to single name parameter reads
        case 'custom':
            outputVariableName = taskParameters.customVariableName
            break

        default:
            throw new Error(`Unknown name transform mode ${taskParameters.variableNameTransform}`)
    }

    if (taskParameters.variableNameTransform === 'none') {
        console.log(tl.loc('UsingParameterNameForVariable', inputParameterName))
    } else {
        console.log(tl.loc('TransformedParameterName', inputParameterName, outputVariableName))
    }

    return outputVariableName
}
