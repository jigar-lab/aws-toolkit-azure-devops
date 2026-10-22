/*!
 * Copyright 2019 Amazon.com, Inc. or its affiliates. All Rights Reserved.
 * SPDX-License-Identifier: MIT
 */

import * as fs from 'fs-extra'
import JsonQuery from 'json-query'
import * as path from 'path'
import validator from 'validator'
import axios from 'axios'

import { buildTasks, releaseVersion, repoRoot, sourceTasks } from './scriptUtils'
import isUUID = validator.isUUID
import isAlphanumeric = validator.isAlphanumeric
import isLength = validator.isLength

const timeMessage = 'Generated resources'
const taskJson = 'task.json'
const taskLocJson = 'task.loc.json'
const vssPath = path.join(repoRoot, 'vss-extension.json')
const vssBuildPath = path.join(repoRoot, 'build', 'vss-extension.json')

function findMatchingFiles(directory: string): string[] {
    return fs.readdirSync(directory)
}

// Strict schema for the remotely fetched endpoints.json. The downloaded
// region keys and descriptions are string-interpolated into the shipped
// task.json manifests, so any value that lands in `availableRegions` ends
// up in the published .vsix. Reject anything that does not match these
// patterns to prevent arbitrary remote content from being embedded.
//
// Region id examples: 'us-east-1', 'eu-central-1', 'cn-north-1'. The AWS
// spec restricts region ids to lowercase ASCII letters, digits and hyphens.
const REGION_KEY_PATTERN = /^[a-z0-9-]{1,32}$/
// Descriptions are human-readable labels such as 'US East (N. Virginia)'.
// Restrict to bounded printable ASCII to keep manifest content predictable
// and prevent control characters or non-ASCII payloads from being shipped.
const REGION_DESCRIPTION_PATTERN = /^[\x20-\x7E]{1,128}$/

function isPlainObject(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value)
}

// Downloads the latest known AWS regions file used by the various
// AWS toolkits and constructs an object we can inject into each
// task's region picker options.
async function fetchLatestRegions(): Promise<string[]> {
    console.log('Fetching AWS regions')

    const endpointsFileUrl = 'https://aws-toolkit-endpoints.s3.amazonaws.com/endpoints.json'

    const availableRegions: any = {}

    try {
        const response = await axios.get(endpointsFileUrl)
        const allEndpoints = response.data

        if (!isPlainObject(allEndpoints) || !Array.isArray(allEndpoints.partitions)) {
            throw new Error(
                `Fetched endpoints.json does not match the expected schema: 'partitions' must be an array`
            )
        }

        for (const partition of allEndpoints.partitions) {
            if (!isPlainObject(partition) || !isPlainObject(partition.regions)) {
                throw new Error(
                    `Fetched endpoints.json partition entry is malformed: 'regions' must be an object`
                )
            }
            const regionKeys = Object.keys(partition.regions)
            regionKeys.forEach((rk: string) => {
                if (!REGION_KEY_PATTERN.test(rk)) {
                    throw new Error(
                        `Fetched endpoints.json contains a region id that does not match ${REGION_KEY_PATTERN}: ${JSON.stringify(rk)}`
                    )
                }
                const regionEntry = (partition.regions as Record<string, unknown>)[rk]
                if (!isPlainObject(regionEntry)) {
                    throw new Error(
                        `Fetched endpoints.json region '${rk}' is malformed: entry must be an object`
                    )
                }
                const description = regionEntry.description
                if (typeof description !== 'string' || !REGION_DESCRIPTION_PATTERN.test(description)) {
                    throw new Error(
                        `Fetched endpoints.json region '${rk}' has an invalid description (must match ${REGION_DESCRIPTION_PATTERN})`
                    )
                }
                availableRegions[rk] = `${description} [${rk.toString()}]`
            })
        }

        return availableRegions
    } catch (err) {
        console.error('Error fetching AWS regions:', err)
        throw err
    }
}

function validateTask(task: any) {
    if (!task.id || !isUUID(task.id)) {
        console.error(`Validation failure, id is a required guid for task:\n${task}`)
        process.exit(1)
    }

    if (!task.name || !isAlphanumeric(task.name)) {
        console.error(`name is a required alphanumeric string for task:\n${task}`)
        process.exit(1)
    }

    if (!task.friendlyName || !isLength(task.friendlyName, { min: 1, max: 40 })) {
        console.error(`friendlyName is a required string <= 40 chars for task:\n${task}`)
        process.exit(1)
    }

    if (!task.instanceNameFormat) {
        console.error(`instanceNameFormat is required for task:\n${task}`)
        process.exit(1)
    }
}

function generateTaskLoc(taskLoc: any, taskPath: string) {
    taskLoc.friendlyName = 'ms-resource:loc.friendlyName'
    taskLoc.helpMarkDown = 'ms-resource:loc.helpMarkDown'
    taskLoc.description = 'ms-resource:loc.description'
    taskLoc.instanceNameFormat = 'ms-resource:loc.instanceNameFormat'

    if (Object.hasOwnProperty.call(taskLoc, 'releaseNotes')) {
        taskLoc.releaseNotes = 'ms-resource:loc.releaseNotes'
    }

    if (Object.hasOwnProperty.call(taskLoc, 'groups')) {
        taskLoc.groups.forEach(function(group: any) {
            if (Object.hasOwnProperty.call(group, 'name')) {
                group.displayName = `ms-resource:loc.group.displayName.${group.name}`
            }
        })
    }

    if (Object.hasOwnProperty.call(taskLoc, 'inputs')) {
        taskLoc.inputs.forEach(function(input: any) {
            if (Object.hasOwnProperty.call(input, 'name')) {
                input.label = `ms-resource:loc.input.label.${input.name}`

                if (Object.hasOwnProperty.call(input, 'helpMarkDown') && input.helpMarkDown) {
                    input.helpMarkDown = `ms-resource:loc.input.help.${input.name}`
                }
            }
        })
    }

    if (Object.hasOwnProperty.call(taskLoc, 'messages')) {
        Object.keys(taskLoc.messages).forEach(function(key) {
            taskLoc.messages[key] = `ms-resource:loc.messages.${key}`
        })
    }

    fs.writeFileSync(path.join(buildTasks, taskPath, taskLocJson), JSON.stringify(taskLoc, undefined, 2))
}

function addVersionToTask(task: any, versionInfo: string) {
    const info = versionInfo.split('.')
    task.version = {
        Major: info[0],
        Minor: info[1],
        Patch: info[2]
    }
}

function addAWSRegionsToTask(task: any, knownRegions: string[]) {
    const regionNameInput = JsonQuery('inputs[name=regionName]', {
        data: task
    }).value

    regionNameInput.options = knownRegions
}

function writeTask(task: any, taskPath: string): void {
    fs.writeFileSync(path.join(buildTasks, taskPath, taskJson), JSON.stringify(task, undefined, 2))
}

function createResjson(task: any, taskPath: string): void {
    const resources: any = {}
    if (Object.hasOwnProperty.call(task, 'friendlyName')) {
        resources['loc.friendlyName'] = task.friendlyName
    }

    if (Object.hasOwnProperty.call(task, 'helpMarkDown')) {
        resources['loc.helpMarkDown'] = task.helpMarkDown
    }

    if (Object.hasOwnProperty.call(task, 'description')) {
        resources['loc.description'] = task.description
    }

    if (Object.hasOwnProperty.call(task, 'instanceNameFormat')) {
        resources['loc.instanceNameFormat'] = task.instanceNameFormat
    }

    if (Object.hasOwnProperty.call(task, 'releaseNotes')) {
        resources['loc.releaseNotes'] = task.releaseNotes
    }

    if (Object.hasOwnProperty.call(task, 'groups')) {
        task.groups.forEach(function(group: any) {
            if (Object.hasOwnProperty.call(group, 'name')) {
                resources[`loc.group.displayName.${group.name}`] = group.displayName
            }
        })
    }

    if (Object.hasOwnProperty.call(task, 'inputs')) {
        task.inputs.forEach(function(input: any) {
            if (Object.hasOwnProperty.call(input, 'name')) {
                resources[`loc.input.label.${input.name}`] = input.label

                if (Object.hasOwnProperty.call(input, 'helpMarkDown') && input.helpMarkDown) {
                    resources[`loc.input.help.${input.name}`] = input.helpMarkDown
                }
            }
        })
    }

    if (Object.hasOwnProperty.call(task, 'messages')) {
        Object.keys(task.messages).forEach(function(key) {
            resources[`loc.messages.${key}`] = task.messages[key]
        })
    }

    const resjsonPath = path.join(buildTasks, taskPath, 'Strings', 'resources.resjson', 'en-US', 'resources.resjson')
    fs.mkdirpSync(path.dirname(resjsonPath))
    fs.writeFileSync(resjsonPath, JSON.stringify(resources, undefined, 2))
}

function generateTaskResources(taskPath: string, knownRegions: string[], versionInfo: string): void {
    const taskJsonPath = path.join(sourceTasks, taskPath, taskJson)
    try {
        fs.accessSync(taskJsonPath)
    } catch (e) {
        return
    }

    const task = JSON.parse(fs.readFileSync(taskJsonPath, 'utf-8'))
    validateTask(task)
    addVersionToTask(task, versionInfo)
    addAWSRegionsToTask(task, knownRegions)
    writeTask(task, taskPath)
    createResjson(task, taskPath)
    generateTaskLoc(task, taskPath)
}

function addVersionToVssExtension(versionInfo: string): void {
    const vss = JSON.parse(fs.readFileSync(vssPath, 'utf-8'))
    vss.version = versionInfo
    fs.writeFileSync(vssBuildPath, JSON.stringify(vss, undefined, 2))
}

;(async () => {
    try {
        console.time(timeMessage)

        const knownRegions = await fetchLatestRegions()

        findMatchingFiles(sourceTasks).forEach(path => {
            generateTaskResources(path, knownRegions, releaseVersion)
        })

        addVersionToVssExtension(releaseVersion)
    } catch (err) {
        console.error('Error generating resources:', err)
        throw err
    }

    console.timeEnd(timeMessage)
})()
