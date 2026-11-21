/**
 * Optional, fully local transcription of voice notes with whisper.cpp.
 *
 * Nothing is downloaded until the user turns it on. Then the app fetches two things into
 * <data dir>/whisper, each checked against a pinned SHA-256:
 *   - the engine: whisper.cpp's `whisper-cli`, built by .github/workflows/whisper-engine.yml
 *   - a model from the official whisper.cpp repository on Hugging Face
 * Audio is converted to 16 kHz mono WAV with macOS's built-in `afconvert`, falling back to a
 * bundled WebAssembly Opus decoder for WhatsApp's OGG voice notes.
 */
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { EventEmitter, once } from 'node:events'
import { createWriteStream, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { cpus, tmpdir } from 'node:os'
import { extname, join } from 'node:path'
import { Readable } from 'node:stream'
import type { ReadableStream as WebReadableStream } from 'node:stream/web'
import type { WhisperModelId, WhisperModelInfo, WhisperStatus } from '@shared/types'
import type { Store } from './db'
import type { AccountManager } from './whatsapp'

export const WHISPER_ENGINE = {
  version: 'v1.9.5',
  url: 'https://github.com/well-prado/zap-mcp/releases/download/whisper-engine-v1.9.5/whisper-cli-v1.9.5-macos-arm64.tar.gz',
  sha256: 'b28a23076e2e3dc0a6c9cab230a3e1047cea3a10fed83cf0f15f4a47b7b85099',
  bytes: 2_091_936
}

const HF = 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main'

export const WHISPER_MODELS: Record<WhisperModelId, WhisperModelInfo & { file: string; sha256: string }> = {
  'large-v3-turbo-q5_0': {
    id: 'large-v3-turbo-q5_0',
    label: 'Recomendado',
    description: 'Whisper large-v3-turbo. Muito melhor em português e áudios com ruído.',
    file: 'ggml-large-v3-turbo-q5_0.bin',
    bytes: 574_041_195,
    sha256: '394221709cd5ad1f40c46e6031ca61bce88931e6e088c188294c6d5a55ffa7e2'
  },
  base: {
    id: 'base',
    label: 'Leve',
    description: 'Whisper base. Baixa rápido e ocupa pouco, mas erra mais palavras.',
    file: 'ggml-base.bin',
    bytes: 147_951_465,
    sha256: '60ed5bc3dd14eea856493d334349b405782ddcaf0028d4b5df4088345fba2efe'
  }
}

const NO_SPEECH = '(áudio sem fala reconhecida)'

function run(cmd: string, args: string[], timeoutMs: number): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) reject(Object.assign(err, { stderr }))
      else resolve({ stdout, stderr })
    })
  })
}

/** Download `url` to `dest`, verifying size and SHA-256. Nothing lands at `dest` unless it matches. */
async function download(
  url: string,
  dest: string,
  expected: { sha256: string; bytes: number },
  signal: AbortSignal,
  onProgress: (received: number, total: number) => void
): Promise<void> {
  const res = await fetch(url, { signal, redirect: 'follow' })
  if (!res.ok || !res.body) throw new Error(`Download falhou (HTTP ${res.status}).`)
  const part = `${dest}.part`
  const out = createWriteStream(part)
  const hash = createHash('sha256')
  let received = 0
  try {
    for await (const chunk of Readable.fromWeb(res.body as unknown as WebReadableStream<Uint8Array>)) {
      hash.update(chunk)
      received += chunk.length
      if (!out.write(chunk)) await once(out, 'drain')
      onProgress(received, expected.bytes)
    }
    await new Promise<void>((resolve, reject) => out.end((err?: Error | null) => (err ? reject(err) : resolve())))
  } catch (err) {
    out.destroy()
    await rm(part, { force: true })
    throw err
  }
  if (received !== expected.bytes || hash.digest('hex') !== expected.sha256) {
    await rm(part, { force: true })
    throw new Error('O arquivo baixado não confere com a assinatura esperada (SHA-256). Nada foi instalado.')
  }
  renameSync(part, dest)
}

/** 16-bit PCM mono WAV from float samples. */
function wavFrom(samples: Float32Array, sampleRate: number): Buffer {
  const buf = Buffer.alloc(44 + samples.length * 2)
  buf.write('RIFF', 0)
  buf.writeUInt32LE(36 + samples.length * 2, 4)
  buf.write('WAVEfmt ', 8)
  buf.writeUInt32LE(16, 16)
  buf.writeUInt16LE(1, 20) // PCM
  buf.writeUInt16LE(1, 22) // mono
  buf.writeUInt32LE(sampleRate, 24)
  buf.writeUInt32LE(sampleRate * 2, 28)
  buf.writeUInt16LE(2, 32)
  buf.writeUInt16LE(16, 34)
  buf.write('data', 36)
  buf.writeUInt32LE(samples.length * 2, 40)
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]))
    buf.writeInt16LE(Math.round(s < 0 ? s * 0x8000 : s * 0x7fff), 44 + i * 2)
  }
  return buf
}

/** Decode an OGG/Opus file to 16 kHz mono WAV in-process (no system codec needed). */
export async function oggOpusToWav(input: string, output: string): Promise<void> {
  const { OggOpusDecoder } = await import('ogg-opus-decoder')
  // `sampleRate` is supported (README, src/OggOpusDecoder.js) but missing from the package's types.
  const decoder = new OggOpusDecoder({ sampleRate: 16000 } as ConstructorParameters<typeof OggOpusDecoder>[0])
  await decoder.ready
  try {
    const { channelData, samplesDecoded } = await decoder.decodeFile(new Uint8Array(await readFile(input)))
    if (!samplesDecoded || !channelData.length) throw new Error('Áudio vazio.')
    let mono = channelData[0]
    if (channelData.length > 1) {
      mono = new Float32Array(samplesDecoded)
      for (const ch of channelData) for (let i = 0; i < samplesDecoded; i++) mono[i] += ch[i] / channelData.length
    }
    await writeFile(output, wavFrom(mono.subarray(0, samplesDecoded), 16000))
  } finally {
    decoder.free()
  }
}

/** Anything macOS can read → 16 kHz mono WAV. Uses afconvert, then the bundled Opus decoder. */
export async function toWav16k(input: string, output: string): Promise<void> {
  try {
    await run('/usr/bin/afconvert', ['-f', 'WAVE', '-d', 'LEI16@16000', '-c', '1', input, output], 120_000)
    if (statSync(output).size > 44) return
  } catch {
    // Some macOS versions cannot open OGG; WhatsApp voice notes are OGG/Opus.
  }
  if (!['.ogg', '.opus', '.oga'].includes(extname(input).toLowerCase())) {
    throw new Error('Não consegui converter este áudio para transcrição.')
  }
  await oggOpusToWav(input, output)
}

export class Transcriber extends EventEmitter {
  private readonly dir: string
  private readonly bin: string
  private installing?: { model: WhisperModelId; abort: AbortController }
  private progress?: WhisperStatus['progress']
  private error?: string
  private chain: Promise<unknown> = Promise.resolve()
  private worker = { running: false, backfill: false, done: 0, failed: 0, again: false, stop: false }
  private lastEmit = 0
  private kickTimer?: NodeJS.Timeout

  constructor(
    dataDir: string,
    private readonly store: Store,
    private readonly accounts: AccountManager
  ) {
    super()
    this.dir = join(dataDir, 'whisper')
    this.bin = join(this.dir, 'bin', 'whisper-cli')
  }

  private modelPath(id: WhisperModelId): string {
    return join(this.dir, 'models', WHISPER_MODELS[id].file)
  }

  private engineInstalled(): boolean {
    try {
      return existsSync(this.bin) && readFileSync(join(this.dir, 'bin', 'VERSION'), 'utf8').trim() === WHISPER_ENGINE.version
    } catch {
      return false
    }
  }

  get ready(): boolean {
    const model = this.store.getSettings().whisperModel
    return !this.installing && !!model && this.engineInstalled() && existsSync(this.modelPath(model))
  }

  private diskBytes(): number {
    const walk = (d: string): number => {
      if (!existsSync(d)) return 0
      return readdirSync(d, { withFileTypes: true }).reduce(
        (sum, e) => sum + (e.isDirectory() ? walk(join(d, e.name)) : statSync(join(d, e.name)).size),
        0
      )
    }
    return walk(this.dir)
  }

  status(): WhisperStatus {
    const settings = this.store.getSettings()
    const state: WhisperStatus['state'] = this.installing ? 'installing' : this.ready ? 'ready' : this.error ? 'error' : 'off'
    return {
      state,
      model: this.installing?.model ?? settings.whisperModel ?? undefined,
      models: Object.values(WHISPER_MODELS).map(({ id, label, description, bytes }) => ({ id, label, description, bytes })),
      progress: this.installing ? this.progress : undefined,
      error: this.error,
      diskBytes: this.diskBytes(),
      untranscribed: this.store.countUntranscribedAudio(),
      worker: { running: this.worker.running, backfill: this.worker.backfill, done: this.worker.done, failed: this.worker.failed }
    }
  }

  private changed(throttle = false): void {
    const now = Date.now()
    if (throttle && now - this.lastEmit < 250) return
    this.lastEmit = now
    this.emit('changed')
  }

  /** Download the engine (if needed) and `model`, then switch to it. */
  async install(model: WhisperModelId): Promise<void> {
    if (this.installing) throw new Error('Já existe uma instalação em andamento.')
    const abort = new AbortController()
    this.installing = { model, abort }
    this.error = undefined
    this.changed()
    try {
      mkdirSync(join(this.dir, 'bin'), { recursive: true })
      mkdirSync(join(this.dir, 'models'), { recursive: true })

      if (!this.engineInstalled()) {
        const archive = join(this.dir, 'engine.tar.gz')
        await download(WHISPER_ENGINE.url, archive, WHISPER_ENGINE, abort.signal, (received, total) => {
          this.progress = { step: 'engine', received, total }
          this.changed(true)
        })
        await run('/usr/bin/tar', ['-xzf', archive, '-C', join(this.dir, 'bin')], 60_000)
        await rm(archive, { force: true })
        await chmod(this.bin, 0o755)
        writeFileSync(join(this.dir, 'bin', 'VERSION'), WHISPER_ENGINE.version)
      }

      const info = WHISPER_MODELS[model]
      if (!existsSync(this.modelPath(model))) {
        await download(`${HF}/${info.file}`, this.modelPath(model), info, abort.signal, (received, total) => {
          this.progress = { step: 'model', received, total }
          this.changed(true)
        })
      }

      // Switching models: free the space of the previous one.
      for (const other of Object.values(WHISPER_MODELS)) {
        if (other.id !== model) await rm(this.modelPath(other.id), { force: true })
      }
      const before = this.store.getSettings()
      this.store.setSettings({
        whisperModel: model,
        whisperAutoSince: before.whisperModel ? before.whisperAutoSince : Date.now()
      })
    } catch (err) {
      this.error = abort.signal.aborted
        ? undefined
        : `Não foi possível instalar o Whisper: ${err instanceof Error ? err.message : String(err)}`
      throw err
    } finally {
      this.installing = undefined
      this.progress = undefined
      this.changed()
    }
  }

  cancelInstall(): void {
    this.installing?.abort.abort()
  }

  /** Delete the engine and models and turn transcription off. Existing transcripts are kept. */
  async remove(): Promise<void> {
    this.cancelInstall()
    this.worker.stop = true
    await this.chain.catch(() => {})
    await rm(this.dir, { recursive: true, force: true })
    this.store.setSettings({ whisperModel: null })
    this.error = undefined
    this.changed()
  }

  /** Run jobs one at a time: whisper uses the GPU and several in parallel would just fight. */
  private serial<T>(job: () => Promise<T>): Promise<T> {
    const next = this.chain.then(job, job)
    this.chain = next.catch(() => {})
    return next
  }

  async transcribeFile(path: string): Promise<string> {
    const settings = this.store.getSettings()
    if (!this.ready || !settings.whisperModel) throw new Error('A transcrição (Whisper) não está instalada no app Zap MCP.')
    const tmp = await mkdtemp(join(tmpdir(), 'zap-whisper-'))
    try {
      const wav = join(tmp, 'audio.wav')
      await toWav16k(path, wav)
      const threads = String(Math.max(2, Math.min(8, cpus().length - 2)))
      // Keep timestamps on (no `-nt`): whisper's no-timestamp decoding mode drops whole sentences.
      // They are stripped from each "[00:00:00.000 --> 00:00:09.140]   text" line below.
      const { stdout } = await run(
        this.bin,
        ['-m', this.modelPath(settings.whisperModel), '-f', wav, '-l', settings.whisperLanguage, '-t', threads, '-np'],
        10 * 60_000
      )
      return stdout
        .split('\n')
        .map((line) => line.replace(/^\[[^\]]*\]\s*/, '').trim())
        .filter(Boolean)
        .join(' ')
    } finally {
      await rm(tmp, { recursive: true, force: true })
    }
  }

  /** Transcript of one voice note / audio message, transcribing (and storing) it if needed. */
  async transcribeMessage(accountId: string, chatJid: string, messageId: string): Promise<string> {
    const cached = this.store.getMessage(accountId, chatJid, messageId)
    if (cached?.transcribed === 1) return cached.text ?? ''
    if (!this.ready) throw new Error('A transcrição (Whisper) não está instalada no app Zap MCP.')
    return this.serial(async () => {
      const again = this.store.getMessage(accountId, chatJid, messageId)
      if (again?.transcribed === 1) return again.text ?? ''
      try {
        const account = this.accounts.get(accountId)
        if (!account) throw new Error('Conta não encontrada.')
        const media = await account.downloadMedia(chatJid, messageId)
        const text = (await this.transcribeFile(media.path)) || NO_SPEECH
        this.store.setTranscript(accountId, chatJid, messageId, text)
        return text
      } catch (err) {
        this.store.setTranscript(accountId, chatJid, messageId, null)
        throw err
      } finally {
        this.changed(true)
      }
    })
  }

  /** New messages arrived: transcribe new voice notes in allowed chats (if enabled). */
  kick(): void {
    clearTimeout(this.kickTimer)
    this.kickTimer = setTimeout(() => void this.drain(), 1500)
  }

  /** Transcribe every voice note already in allowed chats, newest first. */
  backfill(run: boolean): void {
    if (!run) {
      this.worker.stop = true
      this.worker.backfill = false
      this.changed()
      return
    }
    this.worker.backfill = true
    void this.drain()
  }

  private async drain(): Promise<void> {
    const settings = this.store.getSettings()
    if (!this.ready || (!settings.whisperAuto && !this.worker.backfill)) return
    if (this.worker.running) {
      this.worker.again = true
      return
    }
    this.worker.running = true
    this.worker.stop = false
    this.changed()
    try {
      do {
        this.worker.again = false
        for (;;) {
          if (this.worker.stop || !this.ready) break
          const since = this.worker.backfill ? 0 : this.store.getSettings().whisperAutoSince
          const batch = this.store.untranscribedAudio({ since, limit: 5 })
          if (!batch.length) break
          for (const m of batch) {
            if (this.worker.stop) break
            try {
              await this.transcribeMessage(m.account_id, m.chat_jid, m.id)
              this.worker.done++
            } catch {
              this.worker.failed++
            }
          }
        }
      } while (this.worker.again && !this.worker.stop)
    } finally {
      this.worker.running = false
      this.worker.backfill = false
      this.changed()
    }
  }
}
