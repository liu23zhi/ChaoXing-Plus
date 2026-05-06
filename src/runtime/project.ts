import type { ProjectDefinition } from './types.js';

export class Project {
  static create(definition: ProjectDefinition): ProjectDefinition {
    return definition;
  }
}
