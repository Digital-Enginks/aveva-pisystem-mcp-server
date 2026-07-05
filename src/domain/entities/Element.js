export class Element {
  constructor({ webId, name, path, templateName = null, categoryNames = [], hasChildren = false }) {
    this.webId = webId;
    this.name = name;
    this.path = path;
    this.templateName = templateName;
    this.categoryNames = Array.isArray(categoryNames) ? categoryNames : [];
    this.hasChildren = Boolean(hasChildren);
    Object.freeze(this);
  }
}
