/*!
 * Copyright 2019 Amazon.com, Inc. or its affiliates. All Rights Reserved.
 * SPDX-License-Identifier: MIT
 */

import SSM = require('aws-sdk/clients/ssm')
import tl = require('azure-pipelines-task-lib/task')
import { fromBuildVariable, fromInstanceIds, fromTags, TaskParameters } from './TaskParameters'

export class TaskOperations {
    public constructor(public readonly ssmClient: SSM, public readonly taskParameters: TaskParameters) {}

    public async execute(): Promise<void> {
        const request: SSM.SendCommandRequest = {
            DocumentName: this.taskParameters.documentName
        }
        if (this.taskParameters.outputS3KeyPrefix) {
            request.OutputS3KeyPrefix = this.taskParameters.outputS3KeyPrefix
        }
        if (this.taskParameters.outputS3BucketName) {
            request.OutputS3BucketName = this.taskParameters.outputS3BucketName
        }
        if (this.taskParameters.timeout) {
            request.TimeoutSeconds = parseInt(this.taskParameters.timeout, 10)
        }
        if (this.taskParameters.maxErrors) {
            request.MaxErrors = this.taskParameters.maxErrors
        }
        if (this.taskParameters.maxConcurrency) {
            request.MaxConcurrency = this.taskParameters.maxConcurrency
        }
        if (this.taskParameters.serviceRoleARN) {
            request.ServiceRoleArn = this.taskParameters.serviceRoleARN
        }
        if (this.taskParameters.comment) {
            request.Comment = this.taskParameters.comment
        }
        if (this.taskParameters.documentParameters) {
            try {
                request.Parameters = JSON.parse(this.taskParameters.documentParameters)
            } catch (err) {
                throw new Error(
                    `Invalid documentParameters: expected JSON object, got parse error: ${(err as Error).message}`
                )
            }
        }
        if (this.taskParameters.cloudWatchOutputEnabled) {
            request.CloudWatchOutputConfig = {
                CloudWatchOutputEnabled: true
            }

            if (this.taskParameters.cloudWatchLogGroupName) {
                request.CloudWatchOutputConfig.CloudWatchLogGroupName = this.taskParameters.cloudWatchLogGroupName
            }
        }

        switch (this.taskParameters.instanceSelector) {
            case fromInstanceIds:
                request.InstanceIds = this.taskParameters.instanceIds
                break

            case fromTags:
                request.Targets = []
                // Parse each line as Key=Value, splitting only on the first '=' so tag
                // values containing '=' are preserved verbatim. Reject malformed lines
                // (missing '=' or empty key/value) with a clear error rather than
                // silently sending the command to a wider instance set.
                this.taskParameters.instanceTags.forEach(it => {
                    const firstEqualsIndex = it.indexOf('=')
                    if (firstEqualsIndex < 1) {
                        throw new Error(
                            `Invalid instanceTags entry "${it}": expected Key=Value, one per line.`
                        )
                    }
                    const key = it.substring(0, firstEqualsIndex).trim()
                    const value = it.substring(firstEqualsIndex + 1).trim()
                    if (!key || !value) {
                        throw new Error(
                            `Invalid instanceTags entry "${it}": key and value must both be non-empty.`
                        )
                    }
                    const t: SSM.Target = {
                        Key: 'tag:' + key,
                        Values: [value]
                    }
                    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
                    request.Targets!.push(t)
                })
                break

            case fromBuildVariable:
                const instanceIds = tl.getVariable(this.taskParameters.instanceBuildVariable)
                if (instanceIds) {
                    request.InstanceIds = instanceIds.trim().split(',')
                } else {
                    throw new Error(tl.loc('InstanceIdsFromVariableFailed', this.taskParameters.instanceBuildVariable))
                }
                break
        }

        if (this.taskParameters.notificationArn) {
            request.NotificationConfig = {
                NotificationArn: this.taskParameters.notificationArn,
                NotificationType: this.taskParameters.notificationType
            }

            if (this.taskParameters.notificationEvents) {
                request.NotificationConfig.NotificationEvents = [this.taskParameters.notificationEvents]
            }
        }

        const response = await this.ssmClient.sendCommand(request).promise()
        let commandId = ''
        if (response.Command) {
            commandId = `${response.Command.CommandId}`
        } else {
            commandId = `${undefined}`
        }

        if (this.taskParameters.commandIdOutputVariable) {
            console.log(tl.loc('SettingOutputVariable', this.taskParameters.commandIdOutputVariable))
            tl.setVariable(this.taskParameters.commandIdOutputVariable, commandId)
        }

        console.log(tl.loc('TaskCompleted', this.taskParameters.documentName, commandId))
    }
}
