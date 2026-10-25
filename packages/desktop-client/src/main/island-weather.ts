import type { IslandWeather } from '@classhelper/shared';

const cache = new Map<string, { data: IslandWeather | null; retryAt: number }>();
const pending = new Map<string, Promise<IslandWeather>>();

/** 固定天气服务与数值坐标，不接受渲染层传入 URL。失败退避并保留本次运行的缓存。 */
export async function getIslandWeather(
  input: unknown,
  request: typeof fetch = fetch,
): Promise<IslandWeather> {
  const coordinates = input as { latitude?: unknown; longitude?: unknown } | null;
  const latitude = coordinates?.latitude,
    longitude = coordinates?.longitude;
  if (
    typeof latitude !== 'number' ||
    !Number.isFinite(latitude) ||
    Math.abs(latitude) > 90 ||
    typeof longitude !== 'number' ||
    !Number.isFinite(longitude) ||
    Math.abs(longitude) > 180
  )
    throw new Error('请设置有效的经纬度');
  const key = `${latitude.toFixed(4)},${longitude.toFixed(4)}`;
  const stored = cache.get(key);
  if (stored && stored.retryAt > Date.now()) {
    if (stored.data) return { ...stored.data, stale: Date.now() - stored.data.fetchedAt >= 15 * 60_000 };
    throw new Error('天气暂不可用，稍后自动重试');
  }
  const running = pending.get(key);
  if (running) return running;
  const job = Promise.resolve().then(async () => {
    try {
      if (process.env.ELECTRON_SMOKE_TEST === '1' && request === fetch)
        throw new Error('自动验收不访问外部天气服务');
      const url = new URL('https://api.open-meteo.com/v1/forecast');
      url.search = new URLSearchParams({
        latitude: String(latitude),
        longitude: String(longitude),
        current: 'temperature_2m,weather_code,wind_speed_10m',
        forecast_days: '1',
      }).toString();
      const response = await request(url, { signal: AbortSignal.timeout(8000), redirect: 'error' });
      if (!response.ok) throw new Error('天气服务暂不可用');
      const body = await response.text();
      if (body.length > 64_000) throw new Error('天气响应过大');
      const current = JSON.parse(body).current;
      if (
        ![current?.temperature_2m, current?.weather_code, current?.wind_speed_10m].every(
          (value) => typeof value === 'number' && Number.isFinite(value),
        )
      )
        throw new Error('天气数据格式不正确');
      const data: IslandWeather = {
        temperature: current.temperature_2m,
        code: current.weather_code,
        windSpeed: current.wind_speed_10m,
        fetchedAt: Date.now(),
        stale: false,
      };
      cache.set(key, { data, retryAt: Date.now() + 15 * 60_000 });
      return data;
    } catch {
      cache.set(key, { data: stored?.data ?? null, retryAt: Date.now() + 60_000 });
      if (stored?.data) return { ...stored.data, stale: true };
      throw new Error('天气暂不可用，请检查网络或坐标');
    } finally {
      pending.delete(key);
      while (cache.size > 32) cache.delete(cache.keys().next().value!);
    }
  });
  pending.set(key, job);
  return job;
}
