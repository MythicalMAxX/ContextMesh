export class NetworkError extends Error {
    code;
    details;
    constructor(code, message, details) {
        super(message);
        this.name = 'NetworkError';
        this.code = code;
        this.details = details;
    }
}
export const notFound = (message, details) => new NetworkError('NOT_FOUND', message, details);
export const forbidden = (message, details) => new NetworkError('FORBIDDEN', message, details);
export const invalid = (message, details) => new NetworkError('INVALID', message, details);
export const conflict = (message, details) => new NetworkError('CONFLICT', message, details);
//# sourceMappingURL=errors.js.map