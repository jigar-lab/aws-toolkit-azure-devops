/*!
 * Copyright 2019 Amazon.com, Inc. or its affiliates. All Rights Reserved.
 * SPDX-License-Identifier: MIT
 */

import { transformParameterToVariableName, isSafeSsmVariableName, isReservedVariableName } from 'lib/ssm'

const defaultTaskParameters = {
    parameterName: '',
    variableNameTransform: '',
    globalMatch: false,
    caseInsensitiveMatch: false,
    replacementPattern: '',
    replacementText: '',
    customVariableName: ''
}

describe('System Manager Common', () => {
    test('Throws if no transform type specified', () => {
        expect.assertions(1)
        try {
            transformParameterToVariableName(defaultTaskParameters)
        } catch (e) {
            expect(`${e}`).toContain('Unknown name transform')
        }
    })

    test('Uses paramaterName if no inputParamaterName specified', () => {
        const taskParams = { ...defaultTaskParameters }
        taskParams.variableNameTransform = 'none'
        taskParams.parameterName = 'variable'
        const response = transformParameterToVariableName(taskParams)
        expect(response).toContain('variable')
    })

    test('Leaf transform works properly', () => {
        const taskParams = { ...defaultTaskParameters }
        taskParams.variableNameTransform = 'leaf'
        taskParams.parameterName = 'variable'
        const response = transformParameterToVariableName(taskParams, 'hello/there/ok/')
        expect(response).toContain('ok')
    })

    test('Substitute transform works properly', () => {
        const taskParams = { ...defaultTaskParameters }
        taskParams.variableNameTransform = 'substitute'
        taskParams.replacementPattern = 'what'
        taskParams.replacementText = '0000'
        const response = transformParameterToVariableName(taskParams, 'what? ok what?')
        expect(response).toContain('0000? ok what?')
        taskParams.globalMatch = true
        const response2 = transformParameterToVariableName(taskParams, 'what? ok what?')
        expect(response2).toContain('0000? ok 0000?')
        taskParams.caseInsensitiveMatch = true
        const response3 = transformParameterToVariableName(taskParams, 'WhaT? ok what?')
        expect(response3).toContain('0000? ok 0000?')
    })

    test('Custom transform works properly', () => {
        const taskParams = { ...defaultTaskParameters }
        taskParams.variableNameTransform = 'custom'
        taskParams.parameterName = 'variable'
        taskParams.customVariableName = 'variable 2'
        const response = transformParameterToVariableName(taskParams)
        expect(response).toContain('variable 2')
    })

    test('Reserved variable names are detected', () => {
        expect(isReservedVariableName('PATH')).toBe(true)
        expect(isReservedVariableName('path')).toBe(true)
        expect(isReservedVariableName('NODE_OPTIONS')).toBe(true)
        expect(isReservedVariableName('LD_PRELOAD')).toBe(true)
        expect(isReservedVariableName('AWS_ACCESS_KEY_ID')).toBe(true)
        expect(isReservedVariableName('Agent_WorkFolder')).toBe(true)
        expect(isReservedVariableName('SYSTEM_ACCESSTOKEN')).toBe(true)
        expect(isReservedVariableName('BUILD_SOURCEBRANCH')).toBe(true)
        expect(isReservedVariableName('MY_APP_SETTING')).toBe(false)
        expect(isReservedVariableName('dbPassword')).toBe(false)
    })

    test('isSafeSsmVariableName accepts valid identifiers and rejects unsafe names', () => {
        expect(isSafeSsmVariableName('my_var')).toBe(true)
        expect(isSafeSsmVariableName('_internal')).toBe(true)
        expect(isSafeSsmVariableName('DBPassword1')).toBe(true)
        // invalid identifier characters
        expect(isSafeSsmVariableName('my.var')).toBe(false)
        expect(isSafeSsmVariableName('my-var')).toBe(false)
        expect(isSafeSsmVariableName('1startsWithDigit')).toBe(false)
        expect(isSafeSsmVariableName('')).toBe(false)
        expect(isSafeSsmVariableName('contains space')).toBe(false)
        // reserved / process-control names
        expect(isSafeSsmVariableName('PATH')).toBe(false)
        expect(isSafeSsmVariableName('NODE_OPTIONS')).toBe(false)
        expect(isSafeSsmVariableName('LD_PRELOAD')).toBe(false)
        expect(isSafeSsmVariableName('AWS_SECRET_ACCESS_KEY')).toBe(false)
        expect(isSafeSsmVariableName('AGENT_TOOLSDIRECTORY')).toBe(false)
    })
})
