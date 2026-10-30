// Test stand-in for the Workers runtime module `cloudflare:email`.
export class EmailMessage {
  constructor(from, to, raw) { this.from = from; this.to = to; this.raw = raw; }
}
