/* @internal */
namespace ts {
    //exported for tests, possibly dtsgen?
    export function generateTypesForModule(name: string, moduleValue: unknown): string | undefined {
        const outputStatements = generateTypesForModuleAsStatements(name, moduleValue);
        return outputStatements && textChanges.getNewFileText(outputStatements, "\n", formatting.getFormatContext(testFormatSettings));
    }

    //kill
    export function generateTypesForModuleAsStatements(packageName: string, moduleValue: unknown): ReadonlyArray<Statement> | undefined {
        const info = getValueInfo(codefix.moduleSpecifierToValidIdentifier(packageName, ScriptTarget.ESNext), moduleValue, getRecurser(), /*isRoot*/ true); //name
        return info && toStatements(info, OutputKind.ExportEquals);
    }

    type Recurser = <T>(obj: unknown, name: string, cbOk: () => T, cbFail: (isCircularReference: boolean, keyStack: ReadonlyArray<string>) => T) => T;
    function getRecurser(): Recurser {
        const seen = new Set<unknown>();
        const nameStack: string[] = [];

        return (obj, name, cbOk, cbFail) => {
            if (seen.has(obj) || nameStack.length > 4) {
                return cbFail(seen.has(obj), nameStack);
            }

            seen.add(obj);
            nameStack.push(name);
            const res = cbOk();
            nameStack.pop();
            seen.delete(obj);
            return res;
        }
    }

    function getValueInfo(name: string, value: unknown, recurser: Recurser, isRoot = false): ValueInfo | undefined {
        if (!isValidIdentifier(name) && name !== "default") return undefined; // "default" handled specially in `toStatements`
        return recurser(value, name,
            (): ValueInfo => {
                if (typeof value === "function") return getFunctionOrClassInfo(value as AnyFunction, name, recurser);
                if (typeof value === "object" && !isBuiltinType(value as object)) {
                    const entries = getEntriesOfObject(value as object);
                    if (isRoot || entries.some(({ value }) => typeof value === "function")) {
                        return { kind: ValueKind.Namespace, name, members: flatMap(entries, ({ key, value }) => getValueInfo(key, value, recurser)) }
                    }
                }
                return { kind: ValueKind.Const, name, type: getTypeOfValue(value, recurser), comment: undefined };
            },
            (isCircularReference, keyStack): ValueInfo => ({ kind: ValueKind.Const, name, type: create.anyType(), comment: ` ${isCircularReference ? "Circular reference" : "Too-deep object hierarchy"} from ${keyStack.join(".")}` }));
    }

    const enum ValueKind { Const, Function, Class, Namespace }
    interface ValueInfoBase {
        readonly name: string;
    }
    type ValueInfo = ConstInfo | FunctionInfo | ClassInfo | NamespaceInfo;
    interface ConstInfo extends ValueInfoBase {
        readonly kind: ValueKind.Const;
        readonly type: TypeNode;
        readonly comment: string | undefined;
    }
    interface FunctionInfo extends ValueInfoBase {
        readonly kind: ValueKind.Function;
        readonly parameters: ReadonlyArray<ParameterDeclaration>;
        readonly returnType: TypeNode;
        readonly namespaceMembers: ReadonlyArray<Statement>;
    }
    interface ClassInfo extends ValueInfoBase {
        readonly kind: ValueKind.Class;
        readonly members: ReadonlyArray<ClassElementLike>;
        readonly namespaceMembers: ReadonlyArray<Statement> ;
    }
    interface NamespaceInfo extends ValueInfoBase {
        readonly kind: ValueKind.Namespace;
        readonly members: ReadonlyArray<ValueInfo>;
    }

    const enum OutputKind { ExportEquals, NamedExport, NamespaceMember }
    function toNamespaceMemberStatements(v: ValueInfo): ReadonlyArray<Statement> {
        return toStatements(v, OutputKind.NamespaceMember);
    }
    function toStatements(v: ValueInfo, kind: OutputKind): ReadonlyArray<Statement> {
        let mod: create.Modifiers = kind === OutputKind.ExportEquals ? SyntaxKind.DeclareKeyword : kind === OutputKind.NamedExport ? SyntaxKind.ExportKeyword : undefined;
        const exportEquals = kind === OutputKind.ExportEquals ? [create.exportEquals(v.name)] : emptyArray;
        switch (v.kind) {
            case ValueKind.Const: {
                let { name, type, comment } = v;
                if (name === "default") {
                    if (kind !== OutputKind.NamedExport) return emptyArray;
                    //can't `export const default x: number;`. Can `decare const x: number; export default x;`
                    return [
                        create.exportDefault("_default"),
                        create.constVar(mod, "_default", type, comment),
                    ];
                }
                return [...exportEquals, create.constVar(mod, name, type, comment)];
            }
            case ValueKind.Function: {
                const { name, parameters, returnType, namespaceMembers } = v;
                let name2 = name; //!
                if (name === "default") {
                    if (kind !== OutputKind.NamedExport) return emptyArray;
                    mod = [SyntaxKind.ExportKeyword, SyntaxKind.DefaultKeyword];
                    name2 = "_default";
                }
                //test merging default export with namespace
                return [...exportEquals, create.fn(mod, name2, parameters, returnType), ...ns2(name2, namespaceMembers, mod)];
            }
            case ValueKind.Class: {
                const { name, members, namespaceMembers } = v;
                let name2 = name; //!
                if (name === "default") { //dup
                    if (kind !== OutputKind.NamedExport) return emptyArray;
                    mod = [SyntaxKind.ExportKeyword, SyntaxKind.DefaultKeyword];
                    name2 = "_default";
                }
                return [...exportEquals, create.cls(mod, name2, members), ...ns2(name2, namespaceMembers, mod)];
            }
            case ValueKind.Namespace: {
                const { name, members } = v;
                if (kind === OutputKind.ExportEquals) {
                    return flatMap(members, v => toStatements(v, OutputKind.NamedExport));
                }

                let name2 = name; //!
                if (name === "default") { //dup
                    if (kind !== OutputKind.NamedExport) return emptyArray;
                    mod = [SyntaxKind.ExportKeyword, SyntaxKind.DefaultKeyword];
                    name2 = "_default";
                }
                //for decault, `declare namespace _default {}; export default _default;`
                const ns = create.namespace(mod, name2, flatMap(members, toNamespaceMemberStatements));
                return [...(name === "default" ? [create.exportDefault("_default")] : emptyArray), ns];
            }
            default:
                return Debug.assertNever(v);
        }
    }
    //name
    function ns2(name: string, namespaceMembers: ReadonlyArray<Statement>, mod: create.Modifiers): ReadonlyArray<Statement> {
        return namespaceMembers.length === 0 ? emptyArray : [create.namespace(mod, name, namespaceMembers)];
    }
    //name
    function ns2Declare(name: string, namespaceMembers: ReadonlyArray<Statement>): NamespaceDeclaration {
        return create.namespace(SyntaxKind.DeclareKeyword, name, namespaceMembers);
    }

    function getFunctionOrClassInfo(obj: AnyFunction, name: string, recurser: Recurser): FunctionInfo | ClassInfo { //name
        const fnAst = parseClassOrFunctionBody(obj) ;
        const { parameters, returnType } = fnAst === undefined ? { parameters: emptyArray, returnType: create.anyType() } : getParameterListAndReturnType(obj, fnAst);
        const classNonStaticMembers = [...(fnAst ? getConstructorFunctionInstanceMembers(fnAst) : emptyArray), ...getPrototypeMembers(obj)];

        const classStaticMembers: ClassElementLike[] | undefined =
            //If !fnAst, this is a class (with no declared constructor)
            classNonStaticMembers.length !== 0 || !fnAst || fnAst.kind === SyntaxKind.Constructor ? [] : undefined;
        const namespaceMembers = flatMap(getEntriesOfObject(obj), ({ key, value }) => {
            const info = getValueInfo(key, value, recurser);
            if (!info) return;
            if (classStaticMembers) {
                switch (info.kind) {
                    case ValueKind.Const: {
                        const { name, type, comment } = info;
                        classStaticMembers.push(create.property(SyntaxKind.StaticKeyword, name, type, comment));
                        return;
                    }
                    case ValueKind.Function: {
                        const { name, parameters, returnType, namespaceMembers: itsNamespaceMembers } = info;
                        classStaticMembers.push(create.method(SyntaxKind.StaticKeyword, name, parameters, returnType));
                        return itsNamespaceMembers.length ? ns2Declare(name, itsNamespaceMembers) : undefined;
                    }
                }
            }
            return toNamespaceMemberStatements(info);
        });

        if (classStaticMembers) {
            const members = [...classStaticMembers, ...(parameters.length === 0 ? emptyArray : [create.ctr(parameters)]), ...classNonStaticMembers];
            return { kind: ValueKind.Class, name, members, namespaceMembers: namespaceMembers }
        }
        else {
            return { kind: ValueKind.Function, name, parameters, returnType, namespaceMembers: namespaceMembers };
        }
    }

    //HTMLElement: (typeof HTMLElement !== 'undefined') ? HTMLElement : undefined
    const builtins: ReadonlyMap<new (...args: unknown[]) => unknown> = createMapFromTemplate({ Date, RegExp, Map, Set });
    function getBuiltinType(value: object, recurser: Recurser): TypeNode | undefined {
        return isArray(value)
            ? createArrayTypeNode(value.length
                ? recurser(value[0], "0", () => getTypeOfValue(value[0], recurser), () => create.anyType())
                : create.anyType())
            : forEachEntry(builtins, (builtin, builtinName) => value instanceof builtin ? create.typeReference(builtinName) : undefined);
    }
    function isBuiltinType(value: object): boolean {
        return isArray(value) || !!forEachEntry(builtins, b => value instanceof b);
    }

    function getTypeOfValue(value: unknown, recurser: Recurser): TypeNode {
        return value == null ? create.anyType() :
            typeof value === "object" ? getBuiltinType(value as object, recurser) || createTypeLiteralNode(getEntriesOfObject(value as object).map(({ key, value }) =>
                create.propertySignature(key, recurser(value, key, () => getTypeOfValue(value, recurser), () => create.anyType())))) :
            //fn may happen for array with function as first element. But usually handled outside. (TEST)
            typeof value === "function" ? create.typeReference("Function") :
            createKeywordTypeNode(stringToToken(typeof value) as KeywordTypeNode["kind"]);
    }

    // Parses assignments to "this.x" in the constructor into class property declarations
    function getConstructorFunctionInstanceMembers(fnAst: FunctionOrConstructor): ReadonlyArray<PropertyDeclaration> {
        const members: PropertyDeclaration[] = [];
        forEachOwnNodeOfFunction(fnAst, node => {
            if (isAssignmentExpression(node, /*excludeCompoundAssignment*/ true) &&
                isPropertyAccessExpression(node.left) && node.left.expression.kind === SyntaxKind.ThisKeyword) {
                const name = node.left.name.text;
                if (!isJsPrivate(name)) members.push(create.property(/*modifier*/ undefined, name, create.anyType()));
            }
        });
        return members;
    }

    function getPrototypeMembers(fn: AnyFunction): ReadonlyArray<MethodDeclaration> {
        return !fn.prototype ? emptyArray : mapDefined(Object.getOwnPropertyNames(fn.prototype).sort(), name => {
            if (name === "constructor" || isJsPrivate(name)) return undefined;
            const obj: unknown = Object.getOwnPropertyDescriptor(fn.prototype, name)!.value;
            if (typeof obj !== "function") return undefined;
            const fnAst = parseClassOrFunctionBody(obj as AnyFunction);
            if (!fnAst) return undefined;
            const { parameters, returnType } = getParameterListAndReturnType(obj as AnyFunction, fnAst);
            const comment = isNativeFunction(obj as AnyFunction) ? " Native method; no parameter or return type inference available" : undefined;
            return create.method(/*modifier*/ undefined, name, parameters, returnType, comment);
        });
    }

    function isJsPrivate(name: string): boolean {
        return name.startsWith("_");
    }

    function getParameterListAndReturnType(obj: AnyFunction, fnAst: FunctionOrConstructor): { readonly parameters: ReadonlyArray<ParameterDeclaration>, readonly returnType: TypeNode } {
        if (isNativeFunction(obj)) {
            return { parameters: fill(obj.length, i => create.parameter(`p${i}`, create.anyType())), returnType: create.anyType() };
        }
        let usedArguments = false, hasReturn = false;
        forEachOwnNodeOfFunction(fnAst, node => {
            usedArguments = usedArguments || isIdentifier(node) && node.text === "arguments";
            hasReturn = hasReturn || isReturnStatement(node) && !!node.expression && node.expression.kind !== SyntaxKind.VoidExpression;
        });
        const parameters = fnAst.parameters
            ? [
                ...fnAst.parameters.map(p => create.parameter(`${p.name.getText()}`, inferParameterType(fnAst, p))),
                ...(usedArguments ? [create.restParameter("args", createArrayTypeNode(create.anyType()))] : emptyArray),
            ]
            : [create.restParameter("args", createArrayTypeNode(create.anyType()))];
        return { parameters, returnType: hasReturn ? create.anyType() : create.voidType() };
    }

    type FunctionOrConstructor = FunctionExpression | ArrowFunction | ConstructorDeclaration | MethodDeclaration;
    /** Returns 'undefined' for class with no declared constructor */
    function parseClassOrFunctionBody(fn: AnyFunction): FunctionOrConstructor | undefined {
        const str = fn.toString();
        const classOrFunction = tryCast(parseExpression(str), (node): node is FunctionExpression | ArrowFunction | ClassExpression => isFunctionExpression(node) || isArrowFunction(node) || isClassExpression(node));
        return classOrFunction
            ? isClassExpression(classOrFunction) ? find(classOrFunction.members, isConstructorDeclaration) : classOrFunction
            // If that didn't parse, it's a method `m() {}`. Parse again inside of an object literal.
            : cast(first(cast(parseExpression(`{ ${str} }`), isObjectLiteralExpression).properties), isMethodDeclaration);
    }

    function parseExpression(expr: string): Expression {
        const text = `const _ = ${expr}`;
        const srcFile = createSourceFile("test.ts", text, ScriptTarget.Latest, /*setParentNodes*/ true);
        return first(cast(first(srcFile.statements), isVariableStatement).declarationList.declarations).initializer!;
    }

    function isNativeFunction(fn: AnyFunction): boolean {
        return stringContains(fn.toString(), "{ [native code] }");
    }

    function inferParameterType(_fn: FunctionOrConstructor, _param: ParameterDeclaration): TypeNode {
        // TODO: Inspect function body for clues (see inferFromUsage.ts)
        return create.anyType();
    }

    // Descends through all nodes in a function, but not in nested functions.
    function forEachOwnNodeOfFunction(fnAst: FunctionOrConstructor, cb: (node: Node) => void) {
        fnAst.body!.forEachChild(node => {
            cb(node);
            if (!isFunctionLike(node)) node.forEachChild(cb);
        });
    }

    interface ObjectEntry { readonly key: string; readonly value: unknown; }
    function getEntriesOfObject(obj: object): ReadonlyArray<ObjectEntry> {
        return getKeysOfObject(obj).map(key => ({ key, value: (obj as any)[key] })); //todo: fear getters
    }

    const ignoredProperties: ReadonlySet<string> = new Set(["caller", "arguments", "constructor", "super_"]);
    const reservedFunctionProperties: ReadonlySet<string> = new Set(Object.getOwnPropertyNames(noop));
    function getKeysOfObject(obj: object): ReadonlyArray<string> {
        let keys: string[] = [];
        let chain = obj;
        while (chain != null && chain != Object.prototype && chain != Function.prototype) {
            keys.push(...Object.getOwnPropertyNames(chain));
            chain = Object.getPrototypeOf(chain);
        }
        return sortAndDeduplicate<string>(
            keys.filter(k => k[0] !== "_" && !ignoredProperties.has(k) && (typeof obj !== "function" || !reservedFunctionProperties.has(k))),
            compareStringsCaseSensitive);
    }

    //mv?
    function isValidIdentifier(name: string): boolean {
        const keyword = stringToToken(name);
        return !(keyword && isNonContextualKeyword(keyword)) && isIdentifierText(name, ScriptTarget.ESNext);
    }
}
