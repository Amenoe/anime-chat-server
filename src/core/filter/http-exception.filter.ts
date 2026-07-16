import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
} from '@nestjs/common';

@Catch(HttpException)
export class HttpExceptionFilter implements ExceptionFilter {
  catch(exception: HttpException, host: ArgumentsHost) {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse();
    const status = exception.getStatus();

    // 优先取 ValidationPipe / HttpException 的业务文案，避免只剩 "Bad Request Exception"
    const message = this.resolveMessage(exception, status);
    const errorResponse = {
      data: {},
      message,
      code: status,
    };

    response.status(status);
    response.header('Content-Type', 'application/json; charset=utf-8');
    response.send(errorResponse);
  }

  private resolveMessage(exception: HttpException, status: number): string {
    const res = exception.getResponse();
    if (typeof res === 'string' && res.trim()) {
      return res;
    }
    if (res && typeof res === 'object') {
      const msg = (res as { message?: string | string[] }).message;
      if (Array.isArray(msg) && msg.length) {
        return msg.join('; ');
      }
      if (typeof msg === 'string' && msg.trim()) {
        return msg;
      }
    }
    if (exception.message && exception.message !== 'Http Exception') {
      return exception.message;
    }
    return status >= 500 ? 'Service Error' : 'Client Error';
  }
}
