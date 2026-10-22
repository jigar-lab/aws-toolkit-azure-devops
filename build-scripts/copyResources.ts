/*!
 * Copyright 2019 Amazon.com, Inc. or its affiliates. All Rights Reserved.
 * SPDX-License-Identifier: MIT
 */

import fs = require('fs-extra')
import folders = require('./scriptUtils')

const timeMessage = 'Copied resources'
const ignoredFiles = ['tsconfig.json', 'make.json']
const ignoreExtensions = ['.ts']

const filterFunc = (src: string, dest: string) => {
    return (
        ignoredFiles.every(element => !src.endsWith(element)) &&
        ignoreExtensions.every(element => !src.endsWith(element))
    )
}

const options = {
    overwrite: true,
    filter: filterFunc
}

async function run() {
    console.time(timeMessage)
    console.log(`Copying files from ${folders.sourceTasks} to ${folders.buildTasks}`)
    // Prune the staging directory before copying so files that were deleted
    // from the source tree do not survive from a previous build. Without this,
    // packaging would re-ship stale artifacts.
    fs.removeSync(folders.buildTasks)
    await fs.copy(folders.sourceTasks, folders.buildTasks, options)
    console.info('Successfully copied files')
    console.timeEnd(timeMessage)
}

run().catch(error => {
    // Fail hard: the previous implementation logged via console.info and exited
    // 0, which allowed `fullBuild` to continue packaging a partial tree.
    console.error(`Copy failed with error: ${error}`)
    process.exit(1)
})
