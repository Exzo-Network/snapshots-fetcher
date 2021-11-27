import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import * as http from 'http'
import * as https from 'https'
import * as crypto from 'crypto'
import * as multihashes from 'multihashes'
import { importer } from 'ipfs-unixfs-importer'
import CID from 'cids'
import { IFetchComponent } from '@well-known-components/http-server'
import { RemoteEntityDeployment, Server, SnapshotsFetcherComponents } from './types'
import { ContentServerMetricLabels } from './metrics'

export async function fetchJson(url: string, fetcher: IFetchComponent): Promise<any> {
  const response = await fetcher.fetch(url)

  if (!response.ok) {
    throw new Error('Error fetching ' + url + '. Status code was: ' + response.status)
  }

  const body = await response.json()
  return body
}

export async function checkFileExists(file: string): Promise<boolean> {
  return fs.promises
    .access(file, fs.constants.F_OK)
    .then(() => true)
    .catch(() => false)
}

export async function sleep(time: number): Promise<void> {
  if (time <= 0) return
  return new Promise<void>((resolve) => setTimeout(resolve, time))
}

/**
 * Calculates a Qm prefixed hash for Decentraland (NOT CIDv0) from a readable stream
 */
export async function hashStreamV0(stream: AsyncGenerator<Uint8Array>) {
  const hash = crypto.createHash('sha256')
  for await (const chunk of stream) {
    hash.update(chunk)
  }
  let lastDigest = multihashes.encode(hash.digest(), 'sha2-256')
  return new CID(0, 'dag-pb', lastDigest).toBaseEncodedString()
}

/**
 * Calculates a CIDv1 from a readable stream
 */
export async function hashStreamV1(content: AsyncGenerator<Uint8Array>) {
  const block = {
    get: (cid: any) => Promise.reject(new Error(`unexpected block API get for ${cid}`)),
    put: () => Promise.reject(new Error('unexpected block API put')),
  } as any

  let lastCid

  for await (const { cid } of importer([{ content }], block, {
    cidVersion: 1,
    onlyHash: true,
    rawLeaves: true,
  })) {
    lastCid = cid
  }

  return `${lastCid}`
}

export async function assertHash(filename: string, hash: string) {
  if (hash.startsWith('Qm')) {
    const qmHash = await hashStreamV0(fs.createReadStream(filename) as any)
    if (qmHash != hash) {
      throw new Error(
        `Download error: hashes do not match(expected:${hash} != calculated:${qmHash}) for file ${filename}`
      )
    }
  } else if (hash.startsWith('ba')) {
    const baHash = await hashStreamV1(fs.createReadStream(filename) as any)
    if (baHash != hash) {
      throw new Error(
        `Download error: hashes do not match(expected:${hash} != calculated:${baHash}) for file ${filename}`
      )
    }
  } else {
    throw new Error(`Unknown hashing algorithm for hash: ${hash}`)
  }
}

export async function saveToDisk(
  components: Pick<SnapshotsFetcherComponents, 'metrics'>,
  originalUrlString: string,
  destinationFilename: string,
  checkHash?: string
): Promise<{}> {
  let tmpFileName: string

  do {
    tmpFileName = destinationFilename + crypto.randomBytes(16).toString('hex')
    // this is impossible
  } while (await checkFileExists(tmpFileName))

  const metricsLabels: ContentServerMetricLabels = {
    remote_server: '',
  }

  try {
    await new Promise<void>((resolve, reject) => {
      const MAX_REDIRECTS = 10

      function requestWithRedirects(redirectedUrl: string, redirects: number) {
        const url = new URL(redirectedUrl, originalUrlString)
        const httpModule = url.protocol === 'https:' ? https : http
        if (redirects > MAX_REDIRECTS) {
          reject(new Error('Too much redirects'))
          return
        }

        Object.assign(metricsLabels, contentServerMetricLabels(url.toString()))

        const { end: endTimeMeasurement } = components.metrics.startTimer(
          'dcl_content_download_duration_seconds',
          metricsLabels
        )
        httpModule
          .get(url.toString(), (response) => {
            if ((response.statusCode == 302 || response.statusCode == 301) && response.headers.location) {
              // handle redirection
              requestWithRedirects(response.headers.location!, redirects + 1)
              return
            } else if (!response.statusCode || response.statusCode > 300) {
              reject(new Error('Invalid response from ' + url + ' status: ' + response.statusCode))
              return
            } else {
              const file = fs.createWriteStream(tmpFileName, { emitClose: true })
              response.pipe(file)

              response.on('error', (err) => {
                file.close()
                reject(err)
                components.metrics.increment('dcl_content_download_errors_total', metricsLabels)
                endTimeMeasurement()
              })

              file.on('error', (err) => {
                reject(err)
                components.metrics.increment('dcl_content_download_errors_total', metricsLabels)
                endTimeMeasurement()
              })

              file.on('finish', function () {
                file.close() // close() is async, call cb after close completes.
                components.metrics.increment('dcl_content_download_bytes_total', metricsLabels, file.bytesWritten)
                endTimeMeasurement()
                resolve()
              })
            }
          })
          .on('error', function (err) {
            reject(err)
            components.metrics.increment('dcl_content_download_errors_total', metricsLabels)
            endTimeMeasurement()
          })
      }

      requestWithRedirects(originalUrlString, 0)
    })

    // make files not executable
    await fs.promises.chmod(tmpFileName, 0o644)

    // check hash if present. delete file and fail in case of mismatch
    if (checkHash) {
      try {
        await assertHash(tmpFileName, checkHash)
      } catch (e) {
        components.metrics.increment('dcl_content_download_hash_errors_total', metricsLabels)
        // delete the downloaded file if failed
        try {
          await fs.promises.unlink(tmpFileName)
        } catch {}
        throw e
      }
    }

    // delete target file if exists
    if (await checkFileExists(destinationFilename)) {
      await fs.promises.unlink(destinationFilename)
    }

    // move downloaded file to target folder
    await fs.promises.rename(tmpFileName, destinationFilename)
  } finally {
    // Delete the file async. (But we don't check the result)
    fs.unlink(tmpFileName, () => {})
  }

  return {}
}

export function coerceEntityDeployment(value: any): RemoteEntityDeployment | null {
  if (
    value &&
    typeof value == 'object' &&
    typeof value.entityId == 'string' &&
    typeof value.entityType == 'string' &&
    typeof value.localTimestamp == 'number' &&
    Array.isArray(value.authChain)
  ) {
    return value
  }

  console.error('ERROR: Invalid entity deployment', value)
  return null
}

export function pickLeastRecentlyUsedServer(
  serversToPickFrom: Server[],
  _serverMap: Map<string, number /* timestamp */>
): string {
  let mostSuitableOption = serversToPickFrom[Math.floor(Math.random() * serversToPickFrom.length)]
  // TODO: implement load balancing strategy
  return mostSuitableOption
}

export function contentServerMetricLabels(contentServer: string): ContentServerMetricLabels {
  const url = new URL(contentServer)
  return {
    remote_server: url.origin,
  }
}
