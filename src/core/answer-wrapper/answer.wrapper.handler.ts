import { AnswererWrapper, SearchInformation, Result } from './interface';
import { request } from '../utils/request';
import { sleep } from '../../runtime/dom.js';

export const AnswerWrapperHandlerConfig = {
  timeout_seconds: 60
};

export async function defaultAnswerWrapperHandler(
  answererWrappers: AnswererWrapper[],
  env: {
    title?: string;
    options?: string;
    type?: string;
    [x: string]: any;
  }
): Promise<SearchInformation[]> {
  const searchInfos: SearchInformation[] = [];
  const temp: AnswererWrapper[] = JSON.parse(JSON.stringify(answererWrappers));
  if (temp.length === 0) {
    throw new Error('题库配置不能为空，请配置后重新开始自动答题。');
  }
  await Promise.all(
    temp.map(async (wrapper) => {
      const {
        name = '未知题库',
        homepage = '#',
        method = 'get',
        type = 'fetch',
        contentType = 'json',
        headers = {},
        data: wrapperData = {},
        handler = 'return (res)=> [JSON.stringify(res), undefined]'
      } = wrapper;
      try {
        let results: Result[] = [];
        let requestData;
        let url: URL;
        if (method.toLocaleLowerCase() === 'get') {
          url = new URL(resolvePlaceHolder(wrapper.url, { encodeURI: true }));
          Object.keys(wrapperData).forEach((key) => {
            url.searchParams.set(key, resolvePlaceHolder(wrapperData[key]));
          });
          requestData = {};
        } else if (method.toLocaleLowerCase() === 'post') {
          url = new URL(wrapper.url);
          const data: Record<string, string> = Object.create({});
          Object.keys(wrapperData).forEach((key) => {
            if (typeof (wrapperData as any)[key] === 'object' && Reflect.has((wrapperData as any)[key], 'handler')) {
              const dynamicHandler = Function(Reflect.get((wrapperData as any)[key], 'handler'))();
              if (typeof dynamicHandler !== 'function') {
                throw new Error('data 字段解析器必须返回一个函数');
              }
              const result = dynamicHandler(env);
              Reflect.set(data, key, result);
            } else {
              Reflect.set(data, key, resolvePlaceHolder(wrapperData[key]));
            }
          });

          requestData = data;
        } else {
          throw new Error('不支持的请求方式');
        }

        const responseData = await Promise.race([
          request(url.toString(), {
            method,
            responseType: contentType,
            data: requestData,
            type,
            headers: JSON.parse(JSON.stringify(headers || {}))
          }),
          sleep((AnswerWrapperHandlerConfig.timeout_seconds ?? 60) * 1000)
        ]);
        if (responseData === undefined) {
          throw new Error('题库请求超时，可能是题库问题，或者请检查网络或者重试。');
        }

        const responseHandler = Function(handler)();
        if (typeof responseHandler !== 'function') {
          throw new Error('handler 响应处理器必须返回一个函数');
        }
        const info = responseHandler(responseData);
        if (info && Array.isArray(info)) {
          if (info.every((item: any) => Array.isArray(item))) {
            results = results.concat(
              info.map((item: any) => ({
                question: item[0],
                answer: item[1],
                extra_data: item[2] || {}
              }))
            );
          } else {
            results.push({
              question: info[0],
              answer: info[1],
              extra_data: info[2] || {}
            });
          }
        }

        searchInfos.push({
          url: wrapper.url,
          name,
          homepage,
          results,
          response: responseData,
          data: requestData
        });
      } catch (error) {
        console.error(error);
        searchInfos.push({
          url: wrapper.url,
          name,
          homepage,
          results: [],
          response: undefined,
          data: undefined,
          error: (error as any)?.message || '题库连接失败'
        });
      }
    })
  );

  function resolvePlaceHolder(data: any, options?: { encodeURI?: boolean }) {
    if (typeof data === 'string') {
      const matches = data.match(/\${(.*?)}/g) || [];
      matches.forEach((placeHolder) => {
        const value: any = env[placeHolder.replace(/\${(.*)}/, '$1')];
        data = data.replace(placeHolder, options?.encodeURI ? encodeURIComponent(value) : value);
      });
    } else if (typeof data === 'object' && data !== null) {
      const keys = Object.keys(data);
      for (const key of keys) {
        data[key] = resolvePlaceHolder(data[key], options);
      }
    }
    return data;
  }

  return searchInfos;
}
