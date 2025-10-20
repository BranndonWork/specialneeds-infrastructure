const PUBLIC_PATH = 'public/';
const HTTP_STATUS = {
    OK: 200,
    CREATED: 201,
    NO_CONTENT: 204,
    NOT_MODIFIED: 304,
    NOT_FOUND: 404,
    FORBIDDEN: 403,
    METHOD_NOT_ALLOWED: 405,
};
export default {
    async fetch(request, env, ctx) {


        const hasValidHeader = () => request.headers.get(env.AUTH_HEADER_KEY) === env.AUTH_KEY_SECRET;

        const logRequest = async (message, level = "info") => {
            const logPath = `${level}/cloudflare-worker-r2.specialneeds.com-${String(Date.now())}.json`
            await logBucket.put(logPath, JSON.stringify(message));
        }

        const authorizeRequest = (key) => {
            if (!key) return false;
            switch (request.method) {
                case 'PUT':
                case 'DELETE':
                    return hasValidHeader();
                case 'GET':
                    return key.startsWith(PUBLIC_PATH) || hasValidHeader();
                default:
                    return false;
            }
        };

        const setHeaders = (object) => {
            const headers = new Headers();
            if (typeof object?.writeHttpMetadata === 'function') {
                object.writeHttpMetadata(headers);
                headers.set('etag', object.httpEtag);
                headers.set('Cache-Control', 'public, max-age=60');
                headers.set('Last-Modified', object.uploaded);
                headers.set('Age', Math.floor((Date.now() - Date.parse(object.uploaded)) / 1000));
                headers.set('Content-Length', object.size);
            }
            headers.set('X-Response-Time', Date.now() - requestStartTime);
            headers.set('X-Env', request.headers.get("x-specialneeds-env") === "production" ? "production" : "development");
            return headers;
        }

        const isNotModified = (object) => {
            const requestIfModifiedSince = request.headers.get('If-Modified-Since');
            const notModified = requestIfModifiedSince && Date.parse(requestIfModifiedSince) >= Date.parse(object.uploaded);
            const requestIfNoneMatch = request.headers.get('If-None-Match') === object.httpEtag;
            return notModified || requestIfNoneMatch;
        }

        const hasObjectExpired = (object) => {
            const ttl = object?.customMetadata?.ttl;
            if (!ttl) return false;
            const expiryTimeInMillis = new Date(object.uploaded).getTime() + (object.customMetadata.ttl * 1000);
            let hasExpired = expiryTimeInMillis < Date.now();
            if (hasExpired) cacheBucket.delete(key);
            return hasExpired;
        };

        const getKey = () => {
            const url = new URL(request.url);
            if (url.pathname.endsWith('/') && url.pathname !== '/') {
                url.pathname = url.pathname.slice(0, -1);
            }
            return url.pathname.slice(1) + url.search;
        }

        const buildResponse = (object, status) => {
            const body = object ? object.body : null;
            const headers = setHeaders(object);
            return new Response(body, { headers, status });
        }

        const requestStartTime = Date.now();
        const requestEnvironment = request.headers.get("x-specialneeds-env") === "production" ? "production" : "development";
        const cacheBucket = requestEnvironment === "production" ? env.PROD_BUCKET : env.DEV_BUCKET;
        const logBucket = requestEnvironment === "production" ? env.PROD_LOG_BUCKET : env.DEV_LOG_BUCKET;
        const key = getKey(request);
        const { method } = request;

        if (!authorizeRequest(key)) return buildResponse(null, HTTP_STATUS.FORBIDDEN);
        let result = null;
        let status = null;
        try {
            switch (method) {
                case 'PUT':
                    result = await cacheBucket.put(key, request.body);
                    status = HTTP_STATUS.CREATED;
                    break
                case 'GET':
                    result = await cacheBucket.get(key);
                    status = HTTP_STATUS.OK;
                    if (result === null || hasObjectExpired(result)) {
                        status = HTTP_STATUS.NOT_FOUND;
                    } else if (isNotModified(result)) {
                        status = HTTP_STATUS.NOT_MODIFIED;
                    }
                    break;
                case 'DELETE':
                    await cacheBucket.delete(key);
                    status = HTTP_STATUS.NO_CONTENT;
                    break
                default:
                    status = HTTP_STATUS.METHOD_NOT_ALLOWED;
                    break
            }
        } catch (error) {
            console.error(`Error with ${method} operation:`, error);
            result = String(error);
            status = HTTP_STATUS.INTERNAL_SERVER_ERROR;
            await logRequest({ method, key, status, cf: request.cf, url: request.url }, "error");
        }
        if ([101, 204, 205, 304].includes(status)) result = null;
        return buildResponse(result, status);
    }
};
