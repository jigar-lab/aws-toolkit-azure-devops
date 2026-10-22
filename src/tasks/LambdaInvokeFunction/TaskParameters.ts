/*!
 * Copyright 2019 Amazon.com, Inc. or its affiliates. All Rights Reserved.
 * SPDX-License-Identifier: MIT
 */

import { AWSConnectionParameters, buildConnectionParameters } from 'lib/awsConnectionParameters'
import { getInputOrEmpty, getInputRequired } from 'lib/vstsUtils'
import * as tl from 'azure-pipelines-task-lib/task'

export interface TaskParameters {
    awsConnectionParameters: AWSConnectionParameters
    functionName: string
    payload: string
    invocationType: string
    logType: string
    outputVariable: string
    captureAsSecuredVar: boolean
}

export function buildTaskParameters(): TaskParameters {
    return {
        awsConnectionParameters: buildConnectionParameters(),
        functionName: getInputRequired('functionName'),
        payload: getInputOrEmpty('payload'),
        invocationType: getInputOrEmpty('invocationType'),
        logType: getInputOrEmpty('logType'),
        outputVariable: getInputOrEmpty('outputVariable'),
        captureAsSecuredVar: tl.getBoolInput('captureAsSecuredVar', false)
    }
}
