export type DeclarationPath = (string | number)[]
/** Paths are mapped to source positions by the build-time loader. */
export class DeclarationError extends Error {
  constructor(readonly path: DeclarationPath, message: string) { super(message); this.name = 'DeclarationError' }
}

/** Declaration identity is shared without importing runtime configuration schemas. */
export const schemaConfigs = new WeakSet<object>()
