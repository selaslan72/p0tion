import { HttpsCallable } from "firebase/functions"
import fs from "fs"
import fetch from "@adobe/node-fetch-retry"
import { createWriteStream } from "node:fs"
import { pipeline } from "node:stream"
import { promisify } from "node:util"
import https from "https"
import { ChunkWithUrl, ETagWithPartNumber } from "../../types/index.js"
import { GENERIC_ERRORS, showError } from "./errors.js"
import { readLocalJsonFile } from "./files.js"
import { customSpinner, sleep } from "./utils.js"

// Get local configs.
const { config } = readLocalJsonFile("../../env.json")

export const createS3Bucket = async (cf: HttpsCallable<unknown, unknown>, bucketName: string): Promise<boolean> => {
  // Call createBucket() Cloud Function.
  const response: any = await cf({
    bucketName
  })

  // Return true if exists, otherwise false.
  return response.data
}

/**
 * Check if an object exists in a given AWS S3 bucket.
 * @param cf <HttpsCallable<unknown, unknown>> - the corresponding cloud function.
 * @param bucketName <string> - the name of the AWS S3 bucket.
 * @param objectKey <string> - the identifier of the object.
 * @returns Promise<string> - true if the object exists, otherwise false.
 */
export const objectExist = async (
  cf: HttpsCallable<unknown, unknown>,
  bucketName: string,
  objectKey: string
): Promise<boolean> => {
  // Call checkIfObjectExist() Cloud Function.
  const response: any = await cf({
    bucketName,
    objectKey
  })

  // Return true if exists, otherwise false.
  return response.data
}

/**
 * Initiate the multi part upload in AWS S3 Bucket for a large object.
 * @param cf <HttpsCallable<unknown, unknown>> - the corresponding cloud function.
 * @param bucketName <string> - the name of the AWS S3 bucket.
 * @param objectKey <string> - the identifier of the object.
 * @returns Promise<string> - the Upload ID reference.
 */
export const openMultiPartUpload = async (
  cf: HttpsCallable<unknown, unknown>,
  bucketName: string,
  objectKey: string
): Promise<string> => {
  // Call startMultiPartUpload() Cloud Function.
  const response: any = await cf({
    bucketName,
    objectKey
  })

  // Return Multi Part Upload ID.
  return response.data
}

/**
 * Get chunks and signed urls for a multi part upload.
 * @param cf <HttpsCallable<unknown, unknown>> - the corresponding cloud function.
 * @param bucketName <string> - the name of the AWS S3 bucket.
 * @param objectKey <string> - the identifier of the object.
 * @param filePath <string> - the local path where the file to be uploaded is located.
 * @param uploadId <string> - the multi part upload unique identifier.
 * @param expirationInSeconds <number> - the pre signed url expiration in seconds.
 * @returns Promise<Array, Array>
 */
export const getChunksAndPreSignedUrls = async (
  cf: HttpsCallable<unknown, unknown>,
  bucketName: string,
  objectKey: string,
  filePath: string,
  uploadId: string,
  expirationInSeconds: number
): Promise<Array<ChunkWithUrl>> => {
  // Configuration checks.
  if (!config.CONFIG_STREAM_CHUNK_SIZE_IN_MB) showError(GENERIC_ERRORS.GENERIC_NOT_CONFIGURED_PROPERLY, true)

  // Open a read stream.
  const stream = fs.createReadStream(filePath, { highWaterMark: config.CONFIG_STREAM_CHUNK_SIZE_IN_MB * 1024 * 1024 })

  // Read and store chunks.
  const chunks = []
  for await (const chunk of stream) chunks.push(chunk)

  const numberOfParts = chunks.length
  if (!numberOfParts) showError(GENERIC_ERRORS.GENERIC_FILE_ERROR, true)

  // Call generatePreSignedUrlsParts() Cloud Function.
  const response: any = await cf({
    bucketName,
    objectKey,
    uploadId,
    numberOfParts,
    expirationInSeconds
  })

  return chunks.map((val1, index) => ({
    partNumber: index + 1,
    chunk: val1,
    preSignedUrl: response.data[index]
  }))
}

/**
 * Make a PUT request to upload each part for a multi part upload.
 * @param chunksWithUrls <Array<ChunkWithUrl>> - the array containing chunks and corresponding pre signed urls.
 * @param contentType <string | false> - the content type of the file to upload.
 * @param cf <HttpsCallable<unknown, unknown>> - the CF for enable resumable upload from last chunk by temporarily store the ETags and PartNumbers of already uploaded chunks.
 * @param ceremonyId <string> - the unique identifier of the ceremony.
 * @param alreadyUploadedChunks <any> - the ETag and PartNumber temporary information about the already uploaded chunks.
 * @returns <Promise<Array<ETagWithPartNumber>>>
 */
export const uploadParts = async (
  chunksWithUrls: Array<ChunkWithUrl>,
  contentType: string | false,
  cf?: HttpsCallable<unknown, unknown>,
  ceremonyId?: string,
  alreadyUploadedChunks?: any
): Promise<Array<ETagWithPartNumber>> => {
  // PartNumber and ETags.
  let partNumbersAndETags = []

  // Restore the already uploaded chunks in the same order.
  if (alreadyUploadedChunks) partNumbersAndETags = alreadyUploadedChunks

  // Resume from last uploaded chunk (0 for new multi-part upload).
  const lastChunkIndex = partNumbersAndETags.length

  for (let i = lastChunkIndex; i < chunksWithUrls.length; i += 1) {
    const spinner = customSpinner(`Uploading part ${chunksWithUrls[i].partNumber} / ${chunksWithUrls.length}`, `clock`)
    spinner.start()

    // Make PUT call.
    const putResponse = await fetch(chunksWithUrls[i].preSignedUrl, {
      retryOptions: {
        retryInitialDelay: 500, // 500 ms.
        socketTimeout: 60000, // 60 seconds.
        retryMaxDuration: 300000 // 5 minutes.
      },
      method: "PUT",
      body: chunksWithUrls[i].chunk,
      headers: {
        "Content-Type": contentType.toString(),
        "Content-Length": chunksWithUrls[i].chunk.length.toString()
      },
      agent: new https.Agent({ keepAlive: true })
    })

    // Extract data.
    const eTag = putResponse.headers.get("etag")
    const { partNumber } = chunksWithUrls[i]

    // Store PartNumber and ETag.
    partNumbersAndETags.push({
      ETag: eTag,
      PartNumber: partNumber
    })

    // nb. to be done only when contributing.
    if (!!ceremonyId && !!cf)
      // Call CF to temporary store the chunks ETag and PartNumber info (useful for resumable upload).
      await cf({
        ceremonyId,
        eTag,
        partNumber
      })

    spinner.stop()
  }

  return partNumbersAndETags
}

/**
 * Close the multi part upload in AWS S3 Bucket for a large object.
 * @param cf <HttpsCallable<unknown, unknown>> - the corresponding cloud function.
 * @param bucketName <string> - the name of the AWS S3 bucket.
 * @param objectKey <string> - the identifier of the object.
 * @param uploadId <string> - the multi part upload unique identifier.
 * @param parts Array<ETagWithPartNumber> - the uploaded parts.
 * @returns Promise<string> - the location of the uploaded file.
 */
export const closeMultiPartUpload = async (
  cf: HttpsCallable<unknown, unknown>,
  bucketName: string,
  objectKey: string,
  uploadId: string,
  parts: Array<ETagWithPartNumber>
): Promise<string> => {
  // Call completeMultiPartUpload() Cloud Function.
  const response: any = await cf({
    bucketName,
    objectKey,
    uploadId,
    parts
  })

  // Return uploaded file location.
  return response.data
}

/**
 * Download locally a specified file from the given bucket.
 * @param cf <HttpsCallable<unknown, unknown>> - the corresponding cloud function.
 * @param bucketName <string> - the name of the AWS S3 bucket.
 * @param objectKey <string> - the identifier of the object (storage path).
 * @param localPath <string> - the path where the file will be written.
 * @return <Promise<void>>
 */
export const downloadLocalFileFromBucket = async (
  cf: HttpsCallable<unknown, unknown>,
  bucketName: string,
  objectKey: string,
  localPath: string
): Promise<void> => {
  // Call generateGetObjectPreSignedUrl() Cloud Function.
  const response: any = await cf({
    bucketName,
    objectKey
  })

  // Get the pre-signed url.
  const preSignedUrl = response.data

  // Get request.
  const getResponse = await fetch(preSignedUrl)

  if (!getResponse.ok) showError(`${GENERIC_ERRORS.GENERIC_FILE_ERROR} - ${getResponse.statusText}`, true)

  // Write stream pipeline to locally store the file.
  const streamPipeline = promisify(pipeline)
  await streamPipeline(getResponse.body!, createWriteStream(localPath))

  await sleep(1000) // workaround for fs close.
}