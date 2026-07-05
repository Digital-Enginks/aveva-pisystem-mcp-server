export class EventFrame {
  constructor({ webId, name, path, startTime, endTime = null, templateName = null }) {
    this.webId = webId;
    this.name = name;
    this.path = path;
    this.startTime = startTime;
    this.endTime = endTime;
    this.templateName = templateName;
    Object.freeze(this);
  }
}
