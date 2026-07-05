export class Attribute {
  constructor({ webId, name, path, type, defaultUnitsName = null, dataReferencePlugIn = null }) {
    this.webId = webId;
    this.name = name;
    this.path = path;
    this.type = type;
    this.defaultUnitsName = defaultUnitsName;
    this.dataReferencePlugIn = dataReferencePlugIn;
    Object.freeze(this);
  }

  get isWritable() {
    // Attributes with a PI Point Data Reference can be written to, others are generally read-only
    return this.dataReferencePlugIn === 'PI Point';
  }
}
