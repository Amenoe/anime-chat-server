import {
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { spawn, spawnSync } from 'child_process';
import {
  createReadStream,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { Readable } from 'stream';
import { transcodeConfig } from '../core/config/config';

export type SubtitleTrack = {
  /** 全局 stream index，ffmpeg 用 `-map 0:<index>` 取 */
  index: number;
  codec: string;
  language: string;
  title: string;
  /** PGS/DVD 这类图形字幕无法转成 VTT */
  convertible: boolean;
};

export type ProbedMedia = {
  /** 容器格式，如 matroska,webm / mov,mp4 */
  formatName: string;
  videoCodec: string;
  audioCodec: string;
  width: number;
  height: number;
  durationSec: number;
  /** 内嵌字幕轨（外挂字幕文件目前不下载，见 playback-architecture.md） */
  subtitleTracks: SubtitleTrack[];
};

/** 浏览器 `<video>` 直接播不了的容器 */
const REMUX_CONTAINER = /\.(mkv|avi|wmv|mov|flv|rmvb|m2ts|vob|ogm)$/i;
/** 浏览器能硬解/软解的常见视频编码 */
const BROWSER_VIDEO_CODEC = /^(h264|vp8|vp9|av1|theora)$/i;

/**
 * 播放转封装 / 转码（ffmpeg）。
 *
 * 关键取舍：**输入走 pipe，只喂「已下载的字节」**。
 *
 * qBittorrent 默认预分配，磁盘上的文件大小一开始就是整集大小，直接把路径丢给
 * ffmpeg 会把未下载的空洞当成有效数据（花屏）甚至一路读到 EOF 立刻结束。
 * 所以这里按当前已下载字节数截断输入：下载到哪儿就转封装到哪儿，前端播放器
 * 缓冲耗尽后重试，下一次请求能多转一段 —— 这就是 mkv 的「边下边播」。
 */
@Injectable()
export class MediaTranscodeService {
  private readonly logger = new Logger(MediaTranscodeService.name);
  private available: boolean | null = null;
  private encoder: string | null = null;

  isEnabled(): boolean {
    return transcodeConfig.enabled;
  }

  /** ffmpeg 是否可用（结果缓存；只在首次真正需要时探测） */
  checkAvailable(): boolean {
    if (!this.isEnabled()) return false;
    if (this.available != null) return this.available;
    try {
      const res = spawnSync(transcodeConfig.ffmpegPath, ['-version'], {
        timeout: 5000,
      });
      this.available = res.status === 0;
      if (!this.available) {
        this.logger.warn(
          `ffmpeg 不可用（${transcodeConfig.ffmpegPath}），mkv/HEVC 资源无法转封装`,
        );
      }
    } catch {
      this.available = false;
    }
    return this.available;
  }

  /** 是否是浏览器不认的容器（需要转封装） */
  needsRemux(fileName: string): boolean {
    return REMUX_CONTAINER.test(fileName || '');
  }

  /** 视频编码是否浏览器可能不支持（HEVC / MPEG-2 / VC-1 等） */
  needsVideoTranscode(codec?: string): boolean {
    if (!codec) return false;
    return !BROWSER_VIDEO_CODEC.test(codec);
  }

  /**
   * 读取媒体信息。
   *
   * 下载中的文件可能不完整（缺少结尾的 cues），ffprobe 仍能读出头部编码信息；
   * 失败返回 null，由调用方按「先 copy 试试」处理。
   */
  probe(filePath: string): ProbedMedia | null {
    if (!this.checkProbe()) return null;
    try {
      const res = spawnSync(
        transcodeConfig.ffprobePath,
        [
          '-v',
          'error',
          '-print_format',
          'json',
          '-show_format',
          '-show_streams',
          filePath,
        ],
        { timeout: 8000, maxBuffer: 8 * 1024 * 1024 },
      );
      if (res.status !== 0 || !res.stdout) return null;
      const parsed = JSON.parse(res.stdout.toString()) as {
        format?: { format_name?: string; duration?: string };
        streams?: Array<{
          index?: number;
          codec_type?: string;
          codec_name?: string;
          width?: number;
          height?: number;
          tags?: { language?: string; title?: string };
        }>;
      };
      const streams = parsed.streams || [];
      const video = streams.find((s) => s.codec_type === 'video');
      const audio = streams.find((s) => s.codec_type === 'audio');
      const graphicSub = /pgs|dvd_subtitle|dvb_subtitle|xsub/i;
      const subtitleTracks: SubtitleTrack[] = streams
        .filter((s) => s.codec_type === 'subtitle')
        .map((s, i) => ({
          index: typeof s.index === 'number' ? s.index : i,
          codec: s.codec_name || '',
          language: s.tags?.language || '',
          title: s.tags?.title || '',
          convertible: !graphicSub.test(s.codec_name || ''),
        }));
      return {
        formatName: parsed.format?.format_name || '',
        videoCodec: video?.codec_name || '',
        audioCodec: audio?.codec_name || '',
        width: video?.width || 0,
        height: video?.height || 0,
        durationSec: Number(parsed.format?.duration || 0),
        subtitleTracks,
      };
    } catch (e) {
      this.logger.debug(
        `ffprobe 失败: ${e instanceof Error ? e.message : String(e)}`,
      );
      return null;
    }
  }

  /**
   * 把本地文件的 `[0, availBytes)` 转成 frag-mp4 流。
   *
   * @param filePath   本地视频路径
   * @param availBytes 已下载字节数（必须 > 0）
   * @param probed     可选：已探测的编码信息，用来决定 copy 还是转码
   * @param forceTranscode 强制转码（比如浏览器不支持 HEVC）
   */
  openFmp4Stream(
    filePath: string,
    availBytes: number,
    probed?: ProbedMedia | null,
    forceTranscode = false,
  ): NodeJS.ReadableStream {
    if (!this.checkAvailable()) {
      throw new ServiceUnavailableException(
        '服务器未安装 ffmpeg，无法播放 mkv/HEVC 资源，请换 mp4 源',
      );
    }
    if (!Number.isFinite(availBytes) || availBytes < 1024 * 512) {
      throw new ServiceUnavailableException('缓冲不足，请稍候');
    }

    const transcodeVideo =
      forceTranscode || this.needsVideoTranscode(probed?.videoCodec);
    const copyVideo = !transcodeVideo;
    // HEVC 用 copy 时必须打 hvc1，否则 Safari/部分 Chrome 不认
    const isHevc = /^(hevc|h265)$/i.test(probed?.videoCodec || '');

    const args: string[] = [
      '-hide_banner',
      '-loglevel',
      'error',
      '-fflags',
      '+genpts',
      '-i',
      'pipe:0',
      '-map',
      '0:v:0',
      '-map',
      '0:a:0?',
    ];

    if (copyVideo) {
      args.push('-c:v', 'copy');
      if (isHevc) args.push('-tag:v', 'hvc1');
    } else {
      args.push(...this.videoEncodeArgs());
    }

    if (/^(aac|mp3)$/i.test(probed?.audioCodec || '')) {
      args.push('-c:a', 'copy');
    } else {
      args.push('-c:a', 'aac', '-b:a', '160k', '-ac', '2');
    }

    args.push(
      '-movflags',
      'frag_keyframe+empty_moov+default_base_moof',
      '-f',
      'mp4',
      'pipe:1',
    );

    this.logger.log(
      `fMP4 ${copyVideo ? 'remux' : 'transcode'} ${
        probed?.videoCodec || '?'
      } avail=${(availBytes / 1048576).toFixed(1)}MB`,
    );

    const ff = spawn(transcodeConfig.ffmpegPath, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    const input = createReadStream(filePath, { start: 0, end: availBytes - 1 });
    input.on('error', (e) => {
      this.logger.debug(`转封装输入读取失败: ${e.message}`);
      ff.kill('SIGKILL');
    });
    // ffmpeg 提前退出时写端会 EPIPE，属正常（例如探测到不完整数据）
    ff.stdin.on('error', () => undefined);
    input.pipe(ff.stdin);

    let stderrTail = '';
    ff.stderr.on('data', (chunk: Buffer) => {
      stderrTail = (stderrTail + chunk.toString()).slice(-800);
    });
    ff.on('exit', (code) => {
      if (code && code !== 0) {
        this.logger.debug(`ffmpeg exit ${code}: ${stderrTail}`);
      }
    });

    const stream = ff.stdout as unknown as Readable;
    // 浏览器断开/取消时，别把转码进程留在后台跑
    stream.on('close', () => {
      if (!ff.killed) ff.kill('SIGKILL');
      input.destroy();
    });
    stream.on('error', () => {
      if (!ff.killed) ff.kill('SIGKILL');
      input.destroy();
    });
    return stream;
  }

  private checkProbe(): boolean {
    if (!this.checkAvailable()) return false;
    try {
      const res = spawnSync(transcodeConfig.ffprobePath, ['-version'], {
        timeout: 5000,
      });
      return res.status === 0;
    } catch {
      return false;
    }
  }

  /** H.264 编码参数（硬件优先，回落 libx264） */
  private videoEncodeArgs(): string[] {
    const encoder = this.pickVideoEncoder();
    if (encoder === 'h264_videotoolbox') {
      return [
        '-c:v',
        encoder,
        '-allow_sw',
        '1',
        '-b:v',
        transcodeConfig.maxBitrate,
        '-pix_fmt',
        'yuv420p',
      ];
    }
    if (encoder === 'h264_nvenc') {
      return [
        '-c:v',
        encoder,
        '-preset',
        'p4',
        '-b:v',
        transcodeConfig.maxBitrate,
        '-pix_fmt',
        'yuv420p',
      ];
    }
    if (encoder === 'h264_qsv') {
      return [
        '-c:v',
        encoder,
        '-b:v',
        transcodeConfig.maxBitrate,
        '-pix_fmt',
        'yuv420p',
      ];
    }
    return [
      '-c:v',
      'libx264',
      '-preset',
      transcodeConfig.preset,
      '-crf',
      '23',
      '-maxrate',
      transcodeConfig.maxBitrate,
      '-bufsize',
      '12M',
      '-pix_fmt',
      'yuv420p',
    ];
  }

  /**
   * 转码单个 HLS 分片到磁盘。
   *
   * `-ss` 放在 `-i` 前做**输入侧精确 seek**：每段都从指定时间点重新编码，
   * 段时长稳定在 `durationSec`，播放器按 EXTINF 拼接就不漂移。
   * 代价是每段约 1s 的启动开销 —— 所以只给 mkv/HEVC 这类「本来就要转码」的资源用。
   */
  async transcodeSegment(
    filePath: string,
    startSec: number,
    durationSec: number,
    _probed: ProbedMedia | null,
    outPath: string,
  ): Promise<void> {
    if (!this.checkAvailable()) {
      throw new ServiceUnavailableException(
        '服务器未安装 ffmpeg，无法播放 mkv/HEVC 资源，请换 mp4 源',
      );
    }
    mkdirSync(dirname(outPath), { recursive: true });
    const tmp = `${outPath}.part`;

    const args = [
      '-hide_banner',
      '-loglevel',
      'error',
      '-ss',
      String(Math.max(0, startSec)),
      '-t',
      String(durationSec),
      // 每段都从 0 开始计时 + 丢掉 seek 前的偏移：hls.js 会按 EXTINF 的
      // 累计时间（frag.start）把分片放到正确位置，段间不能带绝对 PTS
      '-copyts',
      '-i',
      filePath,
      '-map',
      '0:v:0',
      '-map',
      '0:a:0?',
      ...this.videoEncodeArgs(),
      '-c:a',
      'aac',
      '-b:a',
      '160k',
      '-ac',
      '2',
      '-avoid_negative_ts',
      'disabled',
      '-f',
      'mpegts',
      tmp,
    ];

    await new Promise<void>((resolve, reject) => {
      const ff = spawn(transcodeConfig.ffmpegPath, args, {
        stdio: ['ignore', 'ignore', 'pipe'],
      });
      let err = '';
      ff.stderr.on('data', (chunk: Buffer) => {
        err = (err + chunk.toString()).slice(-600);
      });
      ff.on('error', reject);
      ff.on('exit', (code) => {
        if (code === 0) resolve();
        else reject(new Error(`ffmpeg 分片转码失败 (${code}): ${err}`));
      });
    });

    renameSync(tmp, outPath);
  }

  /**
   * 提取内嵌字幕轨并转成 WebVTT。
   *
   * ASS 会丢掉样式/字体（ffmpeg 的 webvtt 只保留对白）——这是刻意的：
   * 浏览器原生字幕只认 VTT，保留样式要引入 libass，代价太大。
   */
  async extractSubtitleVtt(
    filePath: string,
    streamIndex: number,
    outPath: string,
  ): Promise<void> {
    if (!this.checkAvailable()) {
      throw new ServiceUnavailableException(
        '服务器未安装 ffmpeg，无法提取内嵌字幕',
      );
    }
    mkdirSync(dirname(outPath), { recursive: true });
    const tmp = `${outPath}.part`;
    await this.runFfmpeg([
      '-hide_banner',
      '-loglevel',
      'error',
      '-i',
      filePath,
      '-map',
      `0:${streamIndex}`,
      '-c:s',
      'webvtt',
      '-f',
      'webvtt',
      tmp,
    ]);
    // 双语字幕（ASS 里原文/译文各一条 Dialogue）转出来是同一时刻的多个 cue，
    // 浏览器会把它们叠在同一行 —— 合并成一条多行 cue，才能上下两行正常显示
    try {
      const raw = readFileSync(tmp, 'utf8');
      writeFileSync(tmp, this.normalizeVtt(raw), 'utf8');
    } catch {
      /* 后处理失败就用 ffmpeg 原样输出 */
    }
    renameSync(tmp, outPath);
  }

  /** 合并「开始时间相同」的相邻 cue（双语字幕），其余内容原样保留 */
  private normalizeVtt(raw: string): string {
    const lines = raw.replace(/\r\n/g, '\n').split('\n');
    const head: string[] = [];
    let i = 0;
    while (i < lines.length && lines[i].trim() !== '') head.push(lines[i++]);
    while (i < lines.length && lines[i].trim() === '') i++;

    const timeRe =
      /^(\d{2}:\d{2}:\d{2}\.\d{3}|\d{2}:\d{2}\.\d{3})\s+-->\s+(\d{2}:\d{2}:\d{2}\.\d{3}|\d{2}:\d{2}\.\d{3})/;
    type Block = { start: string; end: string; text: string[] };
    const blocks: Block[] = [];

    while (i < lines.length) {
      const timeLine = lines[i++];
      const m = timeRe.exec(timeLine);
      if (!m) {
        // 非标准块（NOTE/STYLE 等）：原样塞回去
        blocks.push({ start: timeLine, end: '', text: [] });
        while (i < lines.length && lines[i].trim() !== '') blocks[blocks.length - 1].text.push(lines[i++]);
        while (i < lines.length && lines[i].trim() === '') i++;
        continue;
      }
      const text: string[] = [];
      while (i < lines.length && lines[i].trim() !== '') text.push(lines[i++]);
      while (i < lines.length && lines[i].trim() === '') i++;

      const last = blocks[blocks.length - 1];
      if (last && last.end && last.start === m[1]) {
        last.text.push(...text);
        last.end = m[2];
      } else {
        blocks.push({ start: m[1], end: m[2], text });
      }
    }

    const body = blocks.map((b) =>
      b.end ? `${b.start} --> ${b.end}\n${b.text.join('\n')}` : `${b.start}\n${b.text.join('\n')}`,
    );
    return [head.join('\n'), ...body].join('\n\n') + '\n';
  }

  /** 跑一次 ffmpeg，等它退出（失败抛错并带上 stderr 尾部） */
  private runFfmpeg(args: string[]): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const ff = spawn(transcodeConfig.ffmpegPath, args, {
        stdio: ['ignore', 'ignore', 'pipe'],
      });
      let err = '';
      ff.stderr.on('data', (chunk: Buffer) => {
        err = (err + chunk.toString()).slice(-600);
      });
      ff.on('error', reject);
      ff.on('exit', (code) => {
        if (code === 0) resolve();
        else reject(new Error(`ffmpeg 失败 (${code}): ${err}`));
      });
    });
  }

  /** 某个会话的分片缓存目录 */
  segmentDir(sessionId: string): string {
    const root =
      transcodeConfig.hlsCacheDir || join(tmpdir(), 'anime-chat-hls');
    return join(root, sessionId);
  }

  /** 清理过期分片缓存（默认 6 小时没被访问过的会话目录） */
  cleanupSegmentCache(): void {
    const root =
      transcodeConfig.hlsCacheDir || join(tmpdir(), 'anime-chat-hls');
    try {
      if (!existsSync(root)) return;
      const ttl = transcodeConfig.hlsCacheTtlHours * 3600 * 1000;
      const now = Date.now();
      for (const name of readdirSync(root)) {
        const dir = join(root, name);
        try {
          const st = statSync(dir);
          if (st.isDirectory() && now - st.mtimeMs > ttl) {
            rmSync(dir, { recursive: true, force: true });
          }
        } catch {
          /* 单个目录失败不影响其它 */
        }
      }
    } catch (e) {
      this.logger.debug(
        `HLS 缓存清理失败: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }

  /** 选一个可用的 H.264 编码器：显式配置 > 硬件 > libx264 */
  private pickVideoEncoder(): string {
    if (this.encoder) return this.encoder;
    const configured = transcodeConfig.videoEncoder;
    if (configured && configured !== 'auto') {
      this.encoder = configured;
      return this.encoder;
    }
    const candidates = [
      'h264_videotoolbox',
      'h264_nvenc',
      'h264_qsv',
      'h264_amf',
    ];
    let encoders = '';
    try {
      const res = spawnSync(
        transcodeConfig.ffmpegPath,
        ['-hide_banner', '-encoders'],
        { timeout: 5000 },
      );
      encoders = res.stdout?.toString() || '';
    } catch {
      encoders = '';
    }
    this.encoder =
      candidates.find((name) => encoders.includes(name)) || 'libx264';
    this.logger.log(`转码编码器: ${this.encoder}`);
    return this.encoder;
  }
}
