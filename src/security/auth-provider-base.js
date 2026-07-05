export class AuthProvider {
  async decorate(headers, method) {
    throw new Error('Not implemented');
  }

  async onChallenge(req, res) {
    return false;
  }

  async healthProbe() {
    throw new Error('Not implemented');
  }
}
