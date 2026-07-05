export class Stream {
  constructor({ webId, name, path = null, unitsAbbreviation = null, values = [] }) {
    this.webId = webId;
    this.name = name;
    this.path = path;
    this.unitsAbbreviation = unitsAbbreviation;
    this.values = Object.freeze([...values]);
    Object.freeze(this);
  }
}
