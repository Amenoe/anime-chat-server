import axios, { AxiosRequestConfig, AxiosResponse } from 'axios';
import { HttpsProxyAgent } from 'https-proxy-agent';
import { HttpProxyAgent } from 'http-proxy-agent';
import { Logger } from '@nestjs/common';

const logger = new Logger('OutboundHttp');

/**
 * 服务端出站 HTTP。
 * - 拉订阅 JSON（creamycake 等）默认直连即可
 * - 若部署环境需代理访问外网，配置 OUTBOUND_PROXY
 * 搜源/站点 HTML 若目标无 CORS，也应由服务端代拉，而非浏览器直 fetch。
 */
const proxyUrl = (process.env.OUTBOUND_PROXY || '').trim();

let httpsAgent: HttpsProxyAgent<string> | undefined;
let httpAgent: HttpProxyAgent<string> | undefined;

if (proxyUrl) {
  try {
    httpsAgent = new HttpsProxyAgent(proxyUrl);
    httpAgent = new HttpProxyAgent(proxyUrl);
    logger.log('outbound proxy enabled');
  } catch (e) {
    logger.warn(
      `invalid OUTBOUND_PROXY: ${e instanceof Error ? e.message : e}`,
    );
  }
}

const DEFAULT_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';

export function hasOutboundProxy() {
  return !!(httpsAgent || httpAgent);
}

export async function outboundGet<T = any>(
  url: string,
  conf: AxiosRequestConfig = {},
): Promise<AxiosResponse<T>> {
  const headers = {
    'User-Agent': DEFAULT_UA,
    Accept: '*/*',
    'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
    ...(conf.headers || {}),
  };

  const base: AxiosRequestConfig = {
    timeout: conf.timeout ?? 15000,
    maxRedirects: conf.maxRedirects ?? 5,
    responseType: conf.responseType ?? 'text',
    transformResponse: conf.transformResponse,
    validateStatus: conf.validateStatus ?? ((s) => s >= 200 && s < 400),
    headers,
  };

  // 有代理时挂 agent；无代理时不要写 proxy:false + 空 agent 干扰（部分环境会异常）
  if (httpsAgent || httpAgent) {
    base.proxy = false;
    base.httpAgent = httpAgent;
    base.httpsAgent = httpsAgent;
  }

  try {
    return await axios.get<T>(url, { ...base, ...conf, headers });
  } catch (e: any) {
    const status = e?.response?.status;
    const msg = e instanceof Error ? e.message : String(e);
    logger.warn(`GET ${url.slice(0, 120)} failed: ${status || ''} ${msg}`);
    throw e;
  }
}
