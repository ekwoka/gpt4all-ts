import { exec, spawn, ChildProcessByStdio } from 'node:child_process';
import type { Writable, Readable } from 'node:stream';
import { promisify } from 'node:util';
import { existsSync, chmod, mkdir, createWriteStream } from 'node:fs';
import * as os from 'node:os';
import axios from 'axios';
import * as ProgressBar from 'progress';
import { GPTArguments } from './types';

const availableModels = [
    'gpt4all-lora-quantized',
    'gpt4all-lora-unfiltered-quantized',
] as const;

export type AvailableModels = (typeof availableModels)[number];

export class GPT4All {
    private bot: ChildProcessByStdio<Writable, Readable, null> | null = null;
    private model: AvailableModels;
    private decoderConfig: Partial<GPTArguments>;
    private executablePath: string;
    private modelPath: string;

    constructor(
        model: AvailableModels = 'gpt4all-lora-quantized',
        forceDownload: boolean = false,
        decoderConfig: Partial<GPTArguments> = {},
    ) {
        this.model = model;
        this.decoderConfig = decoderConfig;
        /*
          allowed models:
            M1 Mac/OSX: cd chat;./gpt4all-lora-quantized-OSX-m1
            Linux: cd chat;./gpt4all-lora-quantized-linux-x86
            Windows (PowerShell): cd chat;./gpt4all-lora-quantized-win64.exe
            Intel Mac/OSX: cd chat;./gpt4all-lora-quantized-OSX-intel
        */
        if (!availableModels.includes(model as AvailableModels)) {
            throw new Error(
                `Model ${model} is not supported. Current models supported are:\n${availableModels.join(
                    ',\n',
                )}`,
            );
        }

        this.executablePath = `${os.homedir()}/.nomic/gpt4all`;
        this.modelPath = `${os.homedir()}/.nomic/${model}.bin`;
    }

    async init(forceDownload: boolean = false): Promise<void | void[]> {
        const downloadPromises: Promise<void>[] = [];

        if (forceDownload || !existsSync(this.executablePath)) {
            downloadPromises.push(this.downloadExecutable());
        }

        if (forceDownload || !existsSync(this.modelPath)) {
            downloadPromises.push(this.downloadModel());
        }

        return Promise.all(downloadPromises);
    }

    public async open(): Promise<void> {
        if (this.bot !== null) this.close();

        let spawnArgs = [this.executablePath, '--model', this.modelPath];

        for (let [key, value] of Object.entries(this.decoderConfig)) {
            spawnArgs.push(`--${key}`, value.toString());
        }

        const bot = spawn(spawnArgs[0], spawnArgs.slice(1), {
            stdio: ['pipe', 'pipe', 'ignore'],
        });
        this.bot = bot;

        // wait for the bot to be ready
        await new Promise((resolve) =>
            bot.stdout.on(
                'data',
                (data) => data.toString().includes('>') && resolve(true),
            ),
        );
    }

    public close(): void {
        if (this.bot === null) return;
        this.bot.kill();
        this.bot = null;
    }

    private async downloadExecutable(): Promise<void> {
        let upstream: string;
        const platform = os.platform();

        if (platform === 'darwin') {
            // check for M1 Mac
            const { stdout } = await promisify(exec)('uname -m');
            if (stdout.trim() === 'arm64') {
                upstream =
                    'https://github.com/nomic-ai/gpt4all/blob/main/chat/gpt4all-lora-quantized-OSX-m1?raw=true';
            } else {
                upstream =
                    'https://github.com/nomic-ai/gpt4all/blob/main/chat/gpt4all-lora-quantized-OSX-intel?raw=true';
            }
        } else if (platform === 'linux') {
            upstream =
                'https://github.com/nomic-ai/gpt4all/blob/main/chat/gpt4all-lora-quantized-linux-x86?raw=true';
        } else if (platform === 'win32') {
            upstream =
                'https://github.com/nomic-ai/gpt4all/blob/main/chat/gpt4all-lora-quantized-win64.exe?raw=true';
        } else {
            throw new Error(
                `Your platform is not supported: ${platform}. Current binaries supported are for OSX (ARM and Intel), Linux and Windows.`,
            );
        }

        await this.downloadFile(upstream, this.executablePath);

        chmod(this.executablePath, 0o755, (err) => {
            if (err) {
                throw err;
            }
        });

        console.log(`File downloaded successfully to ${this.executablePath}`);
    }

    private async downloadModel(): Promise<void> {
        const modelUrl = `https://the-eye.eu/public/AI/models/nomic-ai/gpt4all/${this.model}.bin`;

        await this.downloadFile(modelUrl, this.modelPath);

        console.log(`File downloaded successfully to ${this.modelPath}`);
    }

    private async downloadFile(
        url: string,
        destination: string,
    ): Promise<void> {
        const { data, headers } = await axios.get(url, {
            responseType: 'stream',
        });
        const totalSize = parseInt(headers['content-length'], 10);
        const progressBar = new ProgressBar('[:bar] :percent :etas', {
            complete: '=',
            incomplete: ' ',
            width: 20,
            total: totalSize,
        });
        const dir = new URL(`file://${os.homedir()}/.nomic/`);
        mkdir(dir, { recursive: true }, (err) => {
            if (err) {
                throw err;
            }
        });

        const writer = createWriteStream(destination);

        data.on('data', (chunk: any) => {
            progressBar.tick(chunk.length);
        });

        data.pipe(writer);

        return new Promise((resolve, reject) => {
            writer.on('finish', resolve);
            writer.on('error', reject);
        });
    }

    public prompt(prompt: string): Promise<string> {
        const bot = this.bot;
        if (bot === null) {
            throw new Error('Bot is not initialized.');
        }

        bot.stdin.write(prompt + '\n');

        return new Promise((resolve, reject) => {
            let response: string = '';
            let timeoutId: NodeJS.Timeout;

            const onStdoutData = (data: Buffer) => {
                const text = data.toString();
                if (timeoutId) {
                    clearTimeout(timeoutId);
                }

                if (/^\u{001B}.*\n>\s?/mu.test(text)) {
                    // console.log('Response starts with >, end of message - Resolving...');
                    // Debug log: Indicate that the response ends with "\\f"
                    terminateAndResolve(response); // Remove the trailing "\f" delimiter
                } else {
                    timeoutId = setTimeout(() => {
                        // console.log('Timeout reached - Resolving...');
                        // Debug log: Indicate that the timeout has been reached
                        terminateAndResolve(response);
                    }, 4000); // Set a timeout of 4000ms to wait for more data
                }
                // console.log('Received text:', text);
                // Debug log: Show the received text
                response += text;
                // console.log('Updated response:', response);
                // Debug log: Show the updated response
            };

            const onStdoutError = (err: Error) => {
                bot.stdout.removeListener('data', onStdoutData);
                bot.stdout.removeListener('error', onStdoutError);
                reject(err);
            };

            const terminateAndResolve = (finalResponse: string) => {
                bot.stdout.removeListener('data', onStdoutData);
                bot.stdout.removeListener('error', onStdoutError);
                // check for > at the end and remove it
                if (finalResponse.endsWith('>')) {
                    finalResponse = finalResponse.slice(0, -1);
                }
                resolve(finalResponse);
            };

            bot.stdout.on('data', onStdoutData);
            bot.stdout.on('error', onStdoutError);
        });
    }
}
