// Errore in stile Firebase HttpsError, mappato su status HTTP nel router.
export class HttpsError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
    this.name = 'HttpsError';
  }
}
