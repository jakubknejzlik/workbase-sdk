import ts from 'typescript'
import { ANALYZER_VERSION, SUMMARY_VERSION, freeze, hash, type Snapshot, type Span, type Domain, type Diagnostic, type LeafSummary, type Graph, type Reference, type Contract, type Registration, type Coverage } from './model'

type Env = Map<string, Value>
type Value = (
  | { kind: 'unknown'; node: ts.Node; reason: string; possible: Value[] }
  | { kind: 'scalar'; value: string | number | boolean | null | undefined; node: ts.Node }
  | { kind: 'object'; props: Map<string, Value>; errors: Diagnostic[]; node: ts.Node; summary?: LeafSummary }
  | { kind: 'array'; items: Value[]; node: ts.Node }
  | { kind: 'metadata'; refs: { entity: string; field?: string; node: ts.Node }[]; node: ts.Node }
  | { kind: 'function'; node: ts.FunctionDeclaration | ts.FunctionExpression | ts.ArrowFunction; env: Env }
  | { kind: 'lazy'; node: ts.Expression; env: Env }
  | { kind: 'choice'; items: Value[]; node: ts.Node }
) & { use?: ts.Node; chain?: Span[] }
const keys = ['plugins', 'name', 'schemaReferences', 'provides', 'requires', 'optionalRequires']
const unknown = (node: ts.Node, reason: string, possible: Value[] = []): Value => ({ kind: 'unknown', node, reason, possible })
const scalar = (node: ts.Node, value?: string | number | boolean | null): Value => ({ kind: 'scalar', node, value })
function unwrap(node: ts.Expression): ts.Expression {
  return ts.isParenthesizedExpression(node) || ts.isAsExpression(node) || ts.isSatisfiesExpression(node) || ts.isTypeAssertionExpression(node) ? unwrap(node.expression) : node
}
function key(node: ts.PropertyName | undefined): string | undefined {
  return node && (ts.isIdentifier(node) || ts.isStringLiteral(node) || ts.isNumericLiteral(node)) ? node.text : undefined
}
export function span(node: ts.Node): Span {
  const file = node.getSourceFile(), start = node.getStart(file), end = node.getEnd()
  const a = file.getLineAndCharacterOfPosition(start), b = file.getLineAndCharacterOfPosition(end)
  return { file: file.fileName, start, end, line: a.line + 1, column: a.character + 1, endLine: b.line + 1, endColumn: b.character + 1 }
}
const diagnostic = (node: ts.Node, domain: Domain, code: string, message: string, uses: readonly Span[] = []): Diagnostic => ({ domain, code, message, span: span(node), uses,
  repair: domain === 'source' ? 'Capture valid source and all selected dependencies.' : 'Use an immutable literal declaration or a current source-bound dependency summary.' })
export interface AnalyzeOptions { maxModules?: number; maxNodes?: number; maxDepth?: number; maxBranches?: number; summaries?: readonly LeafSummary[] }

/** Pure bounded interpretation of captured syntax; never imports or invokes analyzed modules. */
export function analyze(input: Snapshot, options: AnalyzeOptions = {}): Graph {
  const limits={maxNodes:options.maxNodes??20000,maxModules:options.maxModules??2048,maxDepth:options.maxDepth??80,maxBranches:options.maxBranches??32}
  const summaryHash=hash(JSON.stringify(options.summaries??[]))
  const analysisHash=hash(JSON.stringify([input.fingerprint,ANALYZER_VERSION,SUMMARY_VERSION,limits,summaryHash]))
  const importers=new Map<string,Set<string>>()
  for(const edge of input.resolutions) if(edge.target) {
    const from=importers.get(edge.target)??new Set<string>();from.add(edge.from);importers.set(edge.target,from)
  }
  const files = new Map<string, ts.SourceFile>(), active = new Set<string>(), diagnostics: Diagnostic[] = []
  const references: Reference[] = [], contracts: Contract[] = [], registrations: Registration[] = []
  let work = 0, depth = 0, stabilityWork = 0
  const source = (name: string): ts.SourceFile => {
    if (files.has(name)) return files.get(name)!
    if(files.size >= (options.maxModules ?? 2048)) {
      const file=ts.createSourceFile(name,'',ts.ScriptTarget.Latest,true)
      diagnostics.push(diagnostic(file,'source','invalid-module-budget','Module budget exhausted'))
      return file
    }
    const file = ts.createSourceFile(name, input.sources[name] ?? '', ts.ScriptTarget.Latest, true, name.endsWith('.json') ? ts.ScriptKind.JSON : name.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS)
    files.set(name, file)
    if (!(name in input.sources)) diagnostics.push(diagnostic(file, 'source', 'missing-source', 'Expected source is absent from snapshot'))
    for (const error of (file as ts.SourceFile & { parseDiagnostics: readonly ts.DiagnosticWithLocation[] }).parseDiagnostics) {
      const at = error.start ?? 0
      let token: ts.Node = file
      const locate = (node: ts.Node): void => { if (node.getStart(file) <= at && node.end >= at) { token = node; ts.forEachChild(node, locate) } }
      locate(file)
      diagnostics.push(diagnostic(token, 'source', 'invalid-source', ts.flattenDiagnosticMessageText(error.messageText, '\n')))
    }
    const validateResolution = (node: ts.Node): void => {
      const specifier = (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)
        ? node.moduleSpecifier : ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword && node.arguments[0] && ts.isStringLiteral(node.arguments[0]) ? node.arguments[0] : undefined
      if (specifier && (specifier.text.startsWith('.') || ts.isImportDeclaration(node) && !node.importClause)
        && !input.resolutions.some(edge=>edge.from===name && edge.specifier===specifier.text && edge.target))
        diagnostics.push(diagnostic(specifier,'source','invalid-resolution','Missing expected source/dependency resolution'))
      ts.forEachChild(node, validateResolution)
    }
    validateResolution(file)
    return file
  }
  const edge = (file: ts.SourceFile, specifier: string) => input.resolutions.find(item => item.from === file.fileName && item.specifier === specifier)?.target
  const lazy = (node: ts.Expression, env: Env): Value => ({ kind: 'lazy', node, env: new Map(env) })
  const force = (value: Value): Value => value.kind === 'lazy' ? evaluate(value.node, value.env) : value
  const prop = (value: Value, name: string): Value => {
    value = force(value)
    if (value.kind === 'object') return force(value.props.get(name) ?? scalar(value.node))
    if (value.kind === 'choice') return choice(value.node, value.items.map(item => prop(item, name)))
    return value.kind === 'unknown' ? unknown(value.node, value.reason, value.possible.map(item => prop(item, name))) : unknown(value.node, 'Expected an object projection')
  }
  const functionEnvs = new Map<Env, number>()
  // Compare only dependency-bearing properties; configuration calculations never execute.
  const signature = (value: Value, level = 0): string => {
    value = force(value)
    if (level > 20) return 'unknown:projection-depth'
    switch (value.kind) {
      case 'scalar': return JSON.stringify(['scalar', typeof value.value, value.value])
      case 'metadata': return JSON.stringify(value.refs.map(({ entity, field }) => [entity, field]))
      case 'unknown': return `unknown:${value.reason}:${value.node.getSourceFile().fileName}:${value.node.pos}`
      case 'object': return JSON.stringify([value.errors.map(item => item.code), keys.map(name => [name, signature(value.props.get(name) ?? scalar(value.node), level + 1)])])
      case 'array': case 'choice': return JSON.stringify([value.kind, value.items.map(item => signature(item, level + 1))])
      // Function identity cannot prove equal return projections (including captured environments).
      // Keep alternatives until the call has projected every branch with its actual arguments.
      case 'function': {
        if (!functionEnvs.has(value.env)) functionEnvs.set(value.env, functionEnvs.size)
        return `function:${value.node.getSourceFile().fileName}:${value.node.pos}:${value.node.end}:${functionEnvs.get(value.env)}`
      }
      default: return 'unknown:projection'
    }
  }
  const choice = (node: ts.Node, items: Value[]): Value => {
    const flattened = items.flatMap(item => item.kind === 'choice' ? item.items : [item])
    if (flattened.length > (options.maxBranches ?? 32)) return unknown(node, 'Branch budget exhausted', flattened.slice(0, options.maxBranches ?? 32))
    if (flattened.length && flattened.every((item): item is Extract<Value, {kind:'object'}> => item.kind === 'object')) {
      const names = new Set(flattened.flatMap(item => [...item.props.keys()]))
      return { kind:'object', node, props:new Map([...names].map(name => [name, choice(node, flattened.map(item => item.props.get(name) ?? scalar(item.node)))])),
        errors:flattened.flatMap(item=>item.errors), chain:flattened.map(item=>span(item.node)) }
    }
    if (flattened.length && !flattened.some(item => item.kind === 'function') && flattened.every(item => signature(item) === signature(flattened[0]))) return { ...flattened[0],
      chain: flattened.flatMap(item => [...(item.chain ?? []), span(item.node), ...(item.kind === 'metadata' ? item.refs.map(ref => span(ref.node)) : [])]) }
    return { kind: 'choice', node, items: flattened }
  }
  function metadata(node: ts.Expression): { value: Value; errors: Diagnostic[] } {
    const refs: { entity: string; field?: string; node: ts.Node }[] = [], errors: Diagnostic[] = []
    const invalid = (at: ts.Node, message: string) => errors.push(diagnostic(at, 'schema', 'invalid-metadata', message))
    if (!ts.isArrayLiteralExpression(node)) invalid(node, 'schemaReferences must be an unwrapped literal array')
    else for (const item of node.elements) {
      if(++work > limits.maxNodes) { errors.push(diagnostic(item,'schema','unresolved-metadata','Metadata node budget exhausted')); break }
      if (!ts.isObjectLiteralExpression(item)) { invalid(item, 'Reference item must be a literal object'); continue }
      const seen = new Set<string>(), values: Record<string, ts.StringLiteral> = {}
      const before = errors.length
      let exhausted=false
      for (const member of item.properties) {
        if(++work > limits.maxNodes) { errors.push(diagnostic(member,'schema','unresolved-metadata','Metadata node budget exhausted')); exhausted=true; break }
        const name = key(member.name)
        if (!ts.isPropertyAssignment(member) || !name || !['entity', 'field'].includes(name)
          || seen.has(name) || !ts.isStringLiteral(member.initializer)) { invalid(member, 'Reference item allows only one literal entity and at most one literal field'); continue }
        seen.add(name); values[name] = member.initializer
      }
      if(exhausted) break
      if (!values.entity) invalid(item, 'Reference item requires a literal entity')
      if (errors.length === before) refs.push({ entity: values.entity.text, ...(values.field ? { field: values.field.text } : {}), node: values.field ?? values.entity })
    }
    return { value: { kind: 'metadata', refs, node }, errors }
  }
  function consumers(file: ts.SourceFile, exportedName: string, seen: Set<string>): boolean {
    const identity=`${file.fileName}:consumer:${exportedName}`
    if(seen.has(identity)) return true
    seen.add(identity)
    let valid=true
    for(const otherName of importers.get(file.fileName)??[]) {
      if(++stabilityWork > limits.maxNodes*10) return false
      const other=source(otherName)
      for(const statement of other.statements) {
        if((!ts.isImportDeclaration(statement)&&!ts.isExportDeclaration(statement)) || !statement.moduleSpecifier
          || !ts.isStringLiteral(statement.moduleSpecifier) || edge(other,statement.moduleSpecifier.text)!==file.fileName) continue
        if(ts.isImportDeclaration(statement)) {
          const clause=statement.importClause, locals:string[]=[]
          if(clause?.name && exportedName==='default') locals.push(clause.name.text)
          if(clause?.namedBindings && ts.isNamespaceImport(clause.namedBindings)) locals.push(clause.namedBindings.name.text)
          if(clause?.namedBindings && ts.isNamedImports(clause.namedBindings)) for(const item of clause.namedBindings.elements)
            if((item.propertyName??item.name).text===exportedName) locals.push(item.name.text)
          for(const local of locals) if(!stable(other,local,seen)) valid=false
        } else if(statement.exportClause && ts.isNamedExports(statement.exportClause)) {
          for(const item of statement.exportClause.elements) if((item.propertyName??item.name).text===exportedName && !consumers(other,item.name.text,seen)) valid=false
        } else if(!statement.exportClause && exportedName!=='default' && !consumers(other,exportedName,seen)) valid=false
      }
    }
    return valid
  }
  function stable(file: ts.SourceFile, name: string, seen = new Set<string>()): boolean {
    if(seen.size > (options.maxDepth ?? 80)) return false
    const identity=file.fileName+':'+name
    if (seen.has(identity)) return true
    seen.add(identity)
    let valid = true
    const exportedNames = new Set<string>()
    for (const statement of file.statements) {
      if (ts.isVariableStatement(statement) && ts.getModifiers(statement)?.some(item=>item.kind===ts.SyntaxKind.ExportKeyword)
        && statement.declarationList.declarations.some(item=>ts.isIdentifier(item.name)&&item.name.text===name)) exportedNames.add(name)
      if (ts.isExportAssignment(statement) && ts.isIdentifier(statement.expression) && statement.expression.text===name) exportedNames.add('default')
      if (ts.isExportDeclaration(statement) && !statement.moduleSpecifier && statement.exportClause && ts.isNamedExports(statement.exportClause))
        for(const item of statement.exportClause.elements) if((item.propertyName??item.name).text===name) exportedNames.add(item.name.text)
    }
    for(const exportedName of exportedNames) if(!consumers(file,exportedName,seen)) valid=false
    const rootName = (node: ts.Node): string | undefined => {
      if (ts.isParenthesizedExpression(node) || ts.isAsExpression(node) || ts.isSatisfiesExpression(node) || ts.isTypeAssertionExpression(node)) return rootName(node.expression)
      if (ts.isIdentifier(node)) return node.text
      if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node) || ts.isCallExpression(node)) return rootName(node.expression)
      return undefined
    }
    // Returned aliases inherit their function/getter owner's consumer stability.
    // Untracked owners remain gaps. Factory-local declarations returned from their
    // own scope remain supported: each invocation creates its own value.
    const localTo = (scope: ts.Node): boolean => {
      let found = false, local = true
      const visitDeclaration = (node: ts.Node): void => {
        if (++stabilityWork > limits.maxNodes * 10) { local = false; return }
        if ((ts.isVariableDeclaration(node) || ts.isParameter(node) || ts.isFunctionDeclaration(node))
          && node.name && ts.isIdentifier(node.name) && node.name.text === name) {
          found = true
          let ancestor: ts.Node | undefined = node.parent
          while (ancestor && ancestor !== scope) ancestor = ancestor.parent
          if (!ancestor) local = false
        }
        ts.forEachChild(node, visitDeclaration)
      }
      visitDeclaration(file)
      return found && local
    }
    const returnedAliasStable = (scope: ts.Node): boolean => {
      if (localTo(scope)) return true
      if (ts.isFunctionDeclaration(scope) && scope.name) return stable(file, scope.name.text, seen)
      // Arrows/function expressions and getters inherit their owning container's
      // consumers. Calls in rootName connect result mutations back to that owner.
      let ancestor = scope
      while (ancestor.parent && !ts.isStatement(ancestor.parent)) {
        const parent = ancestor.parent
        if (ts.isVariableDeclaration(parent) && parent.initializer === ancestor)
          return ts.isIdentifier(parent.name) && stable(file, parent.name.text, seen)
        ancestor = parent
      }
      return false
    }
    const visit = (node: ts.Node) => {
      if(++stabilityWork > (options.maxNodes ?? 20000)*10) { valid=false; return }
      if (ts.isBinaryExpression(node) && node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment && node.operatorToken.kind <= ts.SyntaxKind.LastAssignment && rootName(node.left) === name) valid = false
      if ((ts.isPostfixUnaryExpression(node) || ts.isPrefixUnaryExpression(node) || ts.isDeleteExpression(node)) && rootName(ts.isDeleteExpression(node) ? node.expression : node.operand) === name) valid = false
      if (ts.isCallExpression(node) && (node.arguments.some(arg => rootName(arg) === name) || rootName(node.expression) === name && !ts.isIdentifier(node.expression))) valid = false
      if(ts.isIdentifier(node) && node.text===name && !(ts.isPropertyAssignment(node.parent) && node.parent.name===node) && !(ts.isPropertyAccessExpression(node.parent) && node.parent.name===node)) {
        let ancestor: ts.Node=node
        while(ancestor.parent && !ts.isStatement(ancestor.parent)) {
          const parent=ancestor.parent
          if (ts.isArrowFunction(parent) && parent.body === ancestor && !returnedAliasStable(parent)) valid = false
          if (ts.isCallExpression(parent) && parent.expression === ancestor && rootName(ancestor) !== name) valid = false
          if (ts.isBinaryExpression(parent) && parent.left === ancestor && parent.operatorToken.kind >= ts.SyntaxKind.FirstAssignment && parent.operatorToken.kind <= ts.SyntaxKind.LastAssignment) valid = false
          if ((ts.isPostfixUnaryExpression(parent) || ts.isPrefixUnaryExpression(parent)) && parent.operand === ancestor) valid = false
          if (ts.isDeleteExpression(parent) && parent.expression === ancestor) valid = false
          if(ts.isCallExpression(parent) && parent.arguments.some(arg=>arg===ancestor)) valid=false
          if(ts.isVariableDeclaration(parent) && parent.initializer===ancestor) {
            if(!ts.isIdentifier(parent.name) || parent.name.text!==name && !stable(file,parent.name.text,seen)) valid=false
            break
          }
          ancestor=parent
        }
        if (ancestor.parent && ts.isReturnStatement(ancestor.parent)) {
          let scope: ts.Node | undefined = ancestor.parent.parent
          while (scope && !ts.isFunctionLike(scope)) scope = scope.parent
          if (!scope || !returnedAliasStable(scope)) valid = false
        }
      }
      if (ts.isVariableDeclaration(node) && node.initializer && rootName(unwrap(node.initializer)) === name && (!ts.isIdentifier(node.name) || !stable(file, node.name.text, seen))) valid = false
      ts.forEachChild(node, visit)
    }
    visit(file)
    return valid
  }
  function exported(file: ts.SourceFile, name: string): Value {
    const id = `${file.fileName}:export:${name}`
    if (active.has(id)) return unknown(file, 'Cyclic export')
    active.add(id)
    try {
      const results: Value[] = []
      for (const statement of file.statements) {
        if(++work > limits.maxNodes) return unknown(statement,'Export node budget exhausted',results)
        if (name === 'default' && ts.isExportAssignment(statement) && !statement.isExportEquals) results.push(consumers(file,'default',new Set()) ? evaluate(statement.expression, new Map()) : unknown(statement,'Mutable or escaping default export'))
        if (ts.isExportDeclaration(statement) && !statement.isTypeOnly) {
          const target = statement.moduleSpecifier && ts.isStringLiteral(statement.moduleSpecifier) ? edge(file, statement.moduleSpecifier.text) : undefined
          if (statement.exportClause && ts.isNamedExports(statement.exportClause)) {
            for (const element of statement.exportClause.elements) if (element.name.text === name && !element.isTypeOnly) {
              results.push(statement.moduleSpecifier ? target ? exported(source(target), (element.propertyName ?? element.name).text) : unknown(element, 'Unresolved re-export') : binding(file, (element.propertyName ?? element.name).text, new Map()))
            }
          } else if (!statement.exportClause && name !== 'default') results.push(target ? exported(source(target), name) : unknown(statement, 'Unresolved star re-export'))
        }
        if (ts.canHaveModifiers(statement) && ts.getModifiers(statement)?.some(modifier => modifier.kind === ts.SyntaxKind.ExportKeyword)) {
          if (ts.isVariableStatement(statement)) for (const item of statement.declarationList.declarations) if (ts.isIdentifier(item.name) && item.name.text === name) results.push(binding(file, name, new Map()))
          if (ts.isFunctionDeclaration(statement) && (statement.name?.text === name || name === 'default' && ts.getModifiers(statement)?.some(modifier => modifier.kind === ts.SyntaxKind.DefaultKeyword))) results.push(statement.name && stable(file,statement.name.text) ? { kind: 'function', node: statement, env: new Map() } : unknown(statement,'Mutable or anonymous exported factory'))
        }
      }
      return results.length === 1 ? results[0] : unknown(file, results.length ? 'Ambiguous export' : `Missing export ${name}`, results)
    } finally { active.delete(id) }
  }
  function binding(file: ts.SourceFile, name: string, env: Env): Value {
    if (env.has(name)) return force(env.get(name)!)
    const id = `${file.fileName}:binding:${name}`
    if (active.has(id)) return unknown(file, 'Cyclic binding')
    active.add(id)
    try {
      if (!stable(file, name)) return unknown(file, `Mutable or escaping binding ${name}`)
      for (const statement of file.statements) {
        if (ts.isImportDeclaration(statement) && ts.isStringLiteral(statement.moduleSpecifier) && !statement.importClause?.isTypeOnly) {
          const clause = statement.importClause, target = edge(file, statement.moduleSpecifier.text)
          let imported = clause?.name?.text === name ? 'default' : undefined
          if (clause?.namedBindings && ts.isNamedImports(clause.namedBindings)) for (const element of clause.namedBindings.elements) if (!element.isTypeOnly && element.name.text === name) imported = (element.propertyName ?? element.name).text
          if (imported) return target ? exported(source(target), imported) : unknown(statement, 'Unresolved import')
        }
        if (ts.isFunctionDeclaration(statement) && statement.name?.text === name) return { kind: 'function', node: statement, env: new Map() }
        if (ts.isVariableStatement(statement)) for (const item of statement.declarationList.declarations) if (ts.isIdentifier(item.name) && item.name.text === name) {
          return statement.declarationList.flags & ts.NodeFlags.Const && item.initializer ? evaluate(item.initializer, env) : unknown(item, 'Binding is not an initialized const')
        }
      }
      // Intrinsics are only available after lexical declarations/imports have been checked.
      return name === 'undefined' ? scalar(file) : unknown(file, `Unresolved binding ${name}`)
    } finally { active.delete(id) }
  }
  function applySpread(base: Extract<Value, { kind: 'object' }>, spread: Value): Value {
    spread = force(spread)
    if (spread.kind === 'choice') return choice(spread.node, spread.items.map(item => applySpread(base, item)))
    const props = new Map(base.props), errors = [...base.errors]
    if (spread.kind === 'object') {
      for (const [name, value] of spread.props) props.set(name, value)
      errors.push(...spread.errors)
    } else if (spread.kind === 'scalar' || spread.kind === 'array') { /* primitive/array own keys are absent or numeric, outside this projection */ }
    else {
      for (const name of new Set([...props.keys(), ...keys])) props.set(name, unknown(spread.node, spread.kind === 'unknown' ? spread.reason : 'Unknown spread own keys', [props.get(name) ?? scalar(base.node)]))
    }
    return { kind: 'object', node: base.node, props, errors, summary: base.summary }
  }
  function object(node: ts.ObjectLiteralExpression, env: Env): Value {
    let result: Value = { kind: 'object', node, props: new Map(), errors: [] }
    const declared = new Set<string>()
    for (const member of node.properties) {
      if(++work > limits.maxNodes) return unknown(member,'Object node budget exhausted',[result])
      const update = (base: Value): Value => {
        if (base.kind === 'choice') return choice(node, base.items.map(update))
        if (base.kind !== 'object') return base
        if (ts.isSpreadAssignment(member)) return applySpread(base, evaluate(member.expression, env))
        const name = key(member.name)
        if (!name || name === '__proto__') {
          const result=applySpread(base, unknown(member, 'Computed key or prototype effect'))
          if(result.kind==='object' && (name==='__proto__' || member.name && ts.isComputedPropertyName(member.name) && ts.isStringLiteral(member.name.expression) && member.name.expression.text==='schemaReferences'))
            result.errors.push(diagnostic(member,'schema','invalid-metadata','Computed metadata declarations and prototype effects cannot certify coverage'))
          return result
        }
        const props = new Map(base.props), errors = [...base.errors]
        if (name === 'schemaReferences') {
          if (declared.has(name)) errors.push(diagnostic(member, 'schema', 'invalid-duplicate-metadata', 'Duplicate explicit schemaReferences declaration'))
          if (ts.isPropertyAssignment(member)) { const parsed = metadata(member.initializer); props.set(name, parsed.value); errors.push(...parsed.errors) }
          else { props.set(name, unknown(member, 'Unsupported metadata declaration')); errors.push(diagnostic(member, 'schema', 'invalid-metadata', 'Metadata must be a literal property assignment')) }
        } else if (ts.isPropertyAssignment(member)) props.set(name, lazy(member.initializer, env))
        else if (ts.isShorthandPropertyAssignment(member)) props.set(name, lazy(member.name, env))
        else props.set(name, unknown(member, 'Accessor or method is not a literal property'))
        return { ...base, props, errors }
      }
      result = update(result)
      const name = key(member.name); if (name) declared.add(name)
    }
    return result
  }
  function summaryFor(fn: Extract<Value, { kind: 'function' }>): LeafSummary | undefined {
    const file = fn.node.getSourceFile().fileName, symbol = ts.isFunctionDeclaration(fn.node) ? fn.node.name?.text : undefined
    return options.summaries?.find(item => item.file === file && item.symbol === symbol)
  }
  function summaryValue(summary: LeafSummary, node: ts.Node): Value {
    const actual = Object.fromEntries(Object.keys(summary.dependencies).map(file => [file, hash(input.sources[file] ?? input.dependencies[file] ?? '')]))
    if (summary.version !== SUMMARY_VERSION || summary.sourceHash !== hash(input.sources[summary.file] ?? '')
      || hash(JSON.stringify(Object.entries(actual).sort(([a], [b]) => a.localeCompare(b, 'en')))) !== summary.dependencyHash
      || hash(JSON.stringify(input.resolutions.filter(edge => edge.from in summary.dependencies))) !== summary.resolutionHash
      || Object.entries(summary.dependencies).some(([file, digest]) => actual[file] !== digest || Object.hasOwn(input.dependencies,file) && hash(input.dependencies[file])!==digest)) return unknown(node, 'Stale or incomplete SDK leaf summary')
    const props = new Map<string, Value>([['name', scalar(node, summary.name)], ['schemaReferences', { kind: 'metadata', node, refs: summary.schemaReferences.map(ref => ({ ...ref, node })) }]])
    for (const kind of ['provides', 'requires', 'optionalRequires'] as const) props.set(kind, { kind: 'object', node, errors: [], props: new Map(Object.entries(summary[kind]).map(([name, range]) => [name, scalar(node, range)])) })
    return { kind: 'object', node, props, errors: [], summary }
  }
  function projectFactory(fn: Extract<Value, { kind: 'function' }>, args: readonly ts.Expression[], callerEnv: Env): Value {
    const summary = summaryFor(fn)
    if (summary) return summaryValue(summary, fn.node)
    const node = fn.node
    if (!node.body || node.modifiers?.some(item => item.kind === ts.SyntaxKind.AsyncKeyword) || node.asteriskToken) return unknown(node, 'Unsupported factory body')
    const env = new Map(fn.env)
    // Parameter bindings exist before initializers run; forward/self references must
    // not accidentally resolve to a global intrinsic.
    for (const parameter of node.parameters) if (ts.isIdentifier(parameter.name))
      env.set(parameter.name.text, unknown(parameter, 'Uninitialized factory parameter'))
    for (let i = 0; i < node.parameters.length; i++) {
      const parameter = node.parameters[i]
      if (!ts.isIdentifier(parameter.name) || parameter.dotDotDotToken) return unknown(parameter, 'Unsupported factory parameter')
      const argument = args[i] ? force(evaluate(args[i], callerEnv)) : scalar(parameter)
      // Defaults apply to both omitted and explicit undefined arguments. An unresolved
      // argument may be undefined, so retain the default as another possible value.
      const initialized = parameter.initializer
        ? argument.kind === 'scalar'
          ? argument.value === undefined ? evaluate(parameter.initializer, env) : argument
          : choice(parameter, [argument, evaluate(parameter.initializer, env)])
        : argument
      env.set(parameter.name.text, initialized)
    }
    if (!ts.isBlock(node.body)) return evaluate(node.body, env)
    const block = (statements: readonly ts.Statement[], current: Env): { returns: Value[]; falls: boolean } => {
      const returns: Value[] = []
      // Preserve lexical shadowing even before a declaration is reached. Nested
      // functions remain unsupported when demanded, rather than becoming globals.
      for (const statement of statements) {
        if (ts.isFunctionDeclaration(statement) && statement.name) current.set(statement.name.text, unknown(statement, 'Local factory declaration'))
        if (ts.isVariableStatement(statement)) for (const declaration of statement.declarationList.declarations)
          if (ts.isIdentifier(declaration.name)) current.set(declaration.name.text, unknown(declaration, 'Uninitialized factory binding'))
      }
      for (let i = 0; i < statements.length; i++) {
        const statement = statements[i]
        if(++work > limits.maxNodes) return {returns:[...returns,unknown(statement,'Factory node budget exhausted')],falls:false}
        if (ts.isReturnStatement(statement)) return { returns: [...returns, statement.expression ? evaluate(statement.expression, current) : scalar(statement)], falls: false }
        if (ts.isVariableStatement(statement) && statement.declarationList.flags & ts.NodeFlags.Const) {
          for (const declaration of statement.declarationList.declarations) {
            if (!ts.isIdentifier(declaration.name) || !declaration.initializer || !stable(node.getSourceFile(), declaration.name.text)) return { returns: [...returns, unknown(declaration, 'Mutable factory binding')], falls: false }
            current.set(declaration.name.text, lazy(declaration.initializer, current))
          }
        } else if (ts.isFunctionDeclaration(statement)) { /* unrelated nested returns */ }
        else if (ts.isIfStatement(statement)) {
          const condition = force(evaluate(statement.expression, current))
          const run = (branch: ts.Statement | undefined) => branch ? block(ts.isBlock(branch) ? branch.statements : [branch], new Map(current)) : { returns: [] as Value[], falls: true }
          const branches = condition.kind === 'scalar' ? [run(condition.value ? statement.thenStatement : statement.elseStatement)] : [run(statement.thenStatement), run(statement.elseStatement)]
          let falls = false
          for (const branch of branches) {
            returns.push(...branch.returns)
            if (branch.falls) {
              const continuation = block(statements.slice(i + 1), new Map(current))
              returns.push(...continuation.returns)
              falls ||= continuation.falls
            }
          }
          return { returns, falls }
        } else if (ts.isEmptyStatement(statement)) { /* inert */ }
        else return { returns: [...returns, unknown(statement, 'Unsupported factory effects/control flow')], falls: false }
      }
      return { returns, falls: true }
    }
    const result = block(node.body.statements, env)
    return choice(node, [...result.returns, ...(result.falls ? [unknown(node, 'Factory may fall through')] : [])])
  }
  function evaluate(raw: ts.Expression, env: Env): Value {
    const value = interpret(raw, env)
    return { ...value, use: raw, chain: [...(value.chain ?? []), span(raw)] }
  }
  function interpret(raw: ts.Expression, env: Env): Value {
    const node = unwrap(raw)
    if (++work > (options.maxNodes ?? 20000) || ++depth > (options.maxDepth ?? 80)) { depth--; return unknown(node, 'Analysis budget exhausted') }
    try {
      if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return scalar(node, node.text)
      if (ts.isNumericLiteral(node)) return scalar(node, Number(node.text))
      if (node.kind === ts.SyntaxKind.TrueKeyword || node.kind === ts.SyntaxKind.FalseKeyword) return scalar(node, node.kind === ts.SyntaxKind.TrueKeyword)
      if (node.kind === ts.SyntaxKind.NullKeyword) return scalar(node, null)
      if (ts.isIdentifier(node)) {
        if (env.has(node.text)) return force(env.get(node.text)!)
        return binding(node.getSourceFile(), node.text, env)
      }
      if (ts.isObjectLiteralExpression(node)) return object(node, env)
      if (ts.isArrayLiteralExpression(node)) {
        const items: Value[] = []
        for (const element of node.elements) {
          if (ts.isSpreadElement(element)) { const spread = force(evaluate(element.expression, env)); if (spread.kind === 'array') items.push(...spread.items); else items.push(unknown(element, 'Unresolved registration array spread', [spread])) }
          else items.push(evaluate(element, env))
        }
        return { kind: 'array', node, items }
      }
      if (ts.isArrowFunction(node) || ts.isFunctionExpression(node)) return { kind: 'function', node, env: new Map(env) }
      if (ts.isPropertyAccessExpression(node)) return prop(evaluate(node.expression, env), node.name.text)
      if (ts.isConditionalExpression(node)) { const condition = force(evaluate(node.condition, env)); return condition.kind === 'scalar' ? evaluate(condition.value ? node.whenTrue : node.whenFalse, env) : choice(node, [evaluate(node.whenTrue, env), evaluate(node.whenFalse, env)]) }
      if(ts.isBinaryExpression(node)) {
        const left=force(evaluate(node.left,env)), operator=node.operatorToken.kind
        if(operator===ts.SyntaxKind.AmpersandAmpersandToken) return left.kind==='scalar'
          ? left.value ? evaluate(node.right,env) : left
          : choice(node,[scalar(node,false),evaluate(node.right,env)])
        if(operator===ts.SyntaxKind.BarBarToken || operator===ts.SyntaxKind.QuestionQuestionToken) {
          if(left.kind==='scalar') return (operator===ts.SyntaxKind.QuestionQuestionToken ? left.value!==undefined&&left.value!==null : !!left.value) ? left : evaluate(node.right,env)
          return choice(node,[left,evaluate(node.right,env)])
        }
        if(operator===ts.SyntaxKind.EqualsEqualsEqualsToken || operator===ts.SyntaxKind.ExclamationEqualsEqualsToken) {
          const right=force(evaluate(node.right,env))
          if(left.kind==='scalar'&&right.kind==='scalar') return scalar(node,operator===ts.SyntaxKind.EqualsEqualsEqualsToken ? left.value===right.value : left.value!==right.value)
        }
      }
      if (ts.isCallExpression(node)) {
        const call = (value: Value): Value => {
          const fn = force(value)
          if (fn.kind === 'choice') return choice(node, fn.items.map(call))
          return fn.kind === 'function' ? projectFactory(fn, node.arguments, env) : unknown(node, 'Unresolved factory call')
        }
        return call(evaluate(node.expression, env))
      }
      return unknown(node, 'Unsupported dynamic expression')
    } finally { depth-- }
  }
  function status(domain: Exclude<Domain, 'source'>, list: readonly Diagnostic[]): Coverage[typeof domain] {
    const relevant = list.filter(item => item.domain === domain || item.domain === 'source')
    return relevant.some(item => item.code.startsWith('invalid') || item.domain === 'source') ? 'invalid' : relevant.length ? 'unresolved' : 'complete'
  }
  function collectDescriptor(value: Value, use: Span, id: string, possible = false) {
    value = force(value)
    if (value.kind === 'choice' || value.kind === 'unknown') {
      if(value.kind==='unknown') {
        diagnostics.push(diagnostic(value.node,'registration','unresolved-plugin-identity',value.reason,[use]))
        diagnostics.push(diagnostic(value.node,'contract','unresolved-contract',value.reason,[use]))
      }
      diagnostics.push(diagnostic(value.node, 'schema', 'unresolved-descriptor', value.kind === 'unknown' ? value.reason : 'Factory dependency projections differ', [use]))
      const variants = value.kind === 'choice' ? value.items : value.possible
      for (const variant of variants) collectDescriptor(variant, use, id, true)
      return
    }
    if (value.kind !== 'object') { diagnostics.push(diagnostic(value.node, 'schema', 'unresolved-descriptor', 'Expected plugin descriptor', [use])); return }
    const name = prop(value, 'name')
    if (name.kind !== 'scalar' || typeof name.value !== 'string' || !/^[a-z][a-z0-9_-]*$/.test(name.value)) diagnostics.push(diagnostic(name.node, 'registration', 'unresolved-plugin-identity', 'Expected literal plugin name', [use]))
    diagnostics.push(...value.errors.map(item => ({ ...item, uses: [use] })))
    const refs = prop(value, 'schemaReferences')
    const collectRefs = (item: Value, uncertain: boolean) => {
      item = force(item)
      if (item.kind === 'metadata') for (const ref of item.refs) references.push({ entity: ref.entity, ...(ref.field !== undefined ? { field: ref.field } : {}), span: span(ref.node), uses: [...(item.chain ?? []), ...(value.chain ?? []), span(value.node), use], certainty: uncertain ? 'possible' : 'definite', registration: id })
      else if (item.kind === 'scalar' && item.value === undefined) diagnostics.push(diagnostic(item.node, 'schema', 'unresolved-metadata', 'Declare an explicit schemaReferences inventory, including [] for empty', [use]))
      else if (item.kind === 'unknown' || item.kind === 'choice') {
        diagnostics.push(diagnostic(item.node, 'schema', 'unresolved-metadata', item.kind === 'unknown' ? item.reason : 'Metadata projections differ', [use]))
        for (const variant of item.kind === 'choice' ? item.items : item.possible) collectRefs(variant, true)
      } else diagnostics.push(diagnostic(item.node, 'schema', 'invalid-metadata', 'Unsupported metadata value', [use]))
    }
    collectRefs(refs, possible)
    for (const kind of ['provides', 'requires', 'optionalRequires'] as const) {
      const record = prop(value, kind)
      if (record.kind === 'scalar' && record.value === undefined) continue
      if (record.kind !== 'object') { diagnostics.push(diagnostic(record.node, 'contract', record.kind==='scalar' ? 'invalid-contract' : 'unresolved-contract', 'Contract projection unresolved', [use])); continue }
      for (const [name, rawRange] of record.props) {
        const range = force(rawRange)
        if (/^[a-z][a-z0-9_-]*$/.test(name) && range.kind === 'scalar' && typeof range.value === 'string' && (kind === 'provides' ? /^(0|[1-9]\d*)\.x$/ : /^\^(0|[1-9]\d*)$/).test(range.value)) contracts.push({ kind, name, range: range.value, span: span(range.node), uses: [use], registration: id })
        else diagnostics.push(diagnostic(range.node, 'contract', range.kind==='unknown'||range.kind==='choice' ? 'unresolved-contract' : 'invalid-contract', 'Contract requires a literal supported major range', [use]))
      }
    }
  }
  const entry = source(input.entry)
  // Validate the captured resolution closure even when a module has no demanded exports.
  // Side-effect imports execute independently of which bindings the projection needs.
  const pending = [input.entry], validated = new Set<string>()
  while (pending.length) {
    const name = pending.pop()!
    if (validated.has(name)) continue
    validated.add(name)
    source(name)
    if (validated.size > limits.maxModules) break // source() already records the budget gap
    for (const resolution of input.resolutions) if (resolution.from === name && resolution.target) pending.push(resolution.target)
  }
  for (const failure of input.failures) diagnostics.push(diagnostic(source(failure.file), 'source', 'invalid-capture', failure.message))
  const runtime = exported(entry, 'default'), plugins = prop(runtime, 'plugins')
  const runtimeErrors = (item: Value): void => {
    item = force(item)
    if (item.kind === 'object') diagnostics.push(...item.errors)
    if (item.kind === 'choice') item.items.forEach(runtimeErrors)
  }
  runtimeErrors(runtime)
  const collectPlugins = (value: Value, possible = false): void => {
    value = force(value)
    if (value.kind === 'array') {
      for (const item of value.items) {
        if (item.kind === 'unknown' && ts.isSpreadElement(item.node)) { diagnostics.push(diagnostic(item.node, 'registration', 'unresolved-registration', item.reason)); for(const variant of item.possible) if(variant.kind==='array') collectPlugins(variant,true); continue }
        const contextual={...item,chain:[...(item.chain??[]),...(value.chain??[]),span(value.use??value.node)]}
        const use = span(item.use ?? item.node), id = `${use.file}:${use.start}:${registrations.length}`, before = diagnostics.length
        collectDescriptor(contextual, use, id, possible)
        const added = diagnostics.slice(before), resolved = force(item)
        const name=prop(resolved,'name')
        registrations.push({ id, ...(name.kind==='scalar' && typeof name.value==='string' ? {name:name.value} : {}), span: use, uses: contextual.chain, definitions: [...(resolved.chain ?? []), span(resolved.node)], coverage: { registration: status('registration', added), schema: status('schema', added), contract: status('contract', added) },
          ...(resolved.kind === 'object' && resolved.summary ? { summary: { version: resolved.summary.version, file: resolved.summary.file, symbol: resolved.summary.symbol, dependencyHash: resolved.summary.dependencyHash } } : {}) })
      }
    } else if (value.kind === 'choice' || value.kind === 'unknown') {
      diagnostics.push(diagnostic(value.node, 'registration', 'unresolved-registration', value.kind === 'unknown' ? value.reason : 'Registration projections differ'))
      for (const variant of value.kind === 'choice' ? value.items : value.possible) collectPlugins(variant, true)
    } else diagnostics.push(diagnostic(value.node, 'registration', 'unresolved-registration', 'Expected an explicit plugins array'))
  }
  collectPlugins(plugins)
  // Contract majors/uniqueness follow kernel/composition; schema targets never come from names.
  const names=new Set<string>()
  for(const registration of registrations) if(registration.name) {
    if(names.has(registration.name)) diagnostics.push({domain:'registration',code:'invalid-plugin-identity',message:`Duplicate plugin ${registration.name}`,span:registration.span,uses:[registration.span],repair:'Use unique plugin registration names.'})
    names.add(registration.name)
  }
  const provided=contracts.filter(item=>item.kind==='provides')
  const invalidContract=(contract:Contract,message:string) => diagnostics.push({domain:'contract',code:'invalid-contract-composition',message,span:contract.span,uses:contract.uses,repair:'Supply compatible unique contract providers without dependency cycles.'})
  for(const contract of provided) {
    const peers=provided.filter(item=>item.name===contract.name)
    if(peers.length>1 && (contract.name!=='login' || peers.some(item=>item.range!==contract.range))) invalidContract(contract,`Duplicate/incompatible providers for ${contract.name}`)
  }
  const dependencies=new Map<string,Set<string>>()
  for (const contract of contracts.filter(item => item.kind !== 'provides')) {
    const providers = provided.filter(item => item.name === contract.name)
    if (!providers.length && contract.kind === 'requires' || providers.some(item=>item.range.slice(0,-2)!==contract.range.slice(1))) invalidContract(contract,`Unsatisfied contract ${contract.name} ${contract.range}`)
    const deps=dependencies.get(contract.registration) ?? new Set<string>()
    providers.forEach(provider=>deps.add(provider.registration)); dependencies.set(contract.registration,deps)
  }
  const visited=new Set<string>(), visiting=new Set<string>()
  const visitContract=(id:string):void=>{
    if(visited.has(id)) return
    if(visiting.has(id)) { const contract=contracts.find(item=>item.registration===id); if(contract) invalidContract(contract,'Contract dependency cycle'); return }
    visiting.add(id)
    for(const dependency of dependencies.get(id)??[]) visitContract(dependency)
    visiting.delete(id);visited.add(id)
  }
  registrations.forEach(registration=>visitContract(registration.id))
  const unique = <T>(items: T[]): T[] => [...new Map(items.map(item => [JSON.stringify(item), item])).values()].sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b), 'en'))
  const orderedDiagnostics = unique(diagnostics)
  return freeze({ analyzerVersion: ANALYZER_VERSION, summaryVersion: SUMMARY_VERSION, limits, summaryHash, analysisHash, snapshot: input, registrations: registrations.map(registration=>{
    const relevant=orderedDiagnostics.filter(item=>item.domain==='source'||item.uses.some(use=>use.file===registration.span.file&&use.start===registration.span.start&&use.end===registration.span.end))
    return {...registration,coverage:{registration:status('registration',relevant),schema:status('schema',relevant),contract:status('contract',relevant)}}
  }), references: unique(references), contracts: unique(contracts), diagnostics: orderedDiagnostics,
    coverage: { registration: status('registration', diagnostics), schema: status('schema', diagnostics), contract: status('contract', diagnostics) } })
}
