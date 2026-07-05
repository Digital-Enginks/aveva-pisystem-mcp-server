export class Point {
  constructor({ webId, name, path, pointType, engineeringUnits = null, digitalSetName = null, future = false }) {
    this.webId = webId;
    this.name = name;
    this.path = path;
    this.pointType = pointType;
    this.engineeringUnits = engineeringUnits;
    this.digitalSetName = digitalSetName;
    this.future = Boolean(future);
    Object.freeze(this);
  }
}
