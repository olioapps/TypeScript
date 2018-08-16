/* @internal */
namespace ts {
    export function generateTypesForModule(packageName: string, moduleValue: unknown): ReadonlyArray<Statement> | undefined {
        //Note: packageName must not be "default" (test)
        const vi = getValueInfo(codefix.moduleSpecifierToValidIdentifier(packageName, ScriptTarget.ESNext), moduleValue, /*isRoot*/ true); //name
        return vi && toStatements(vi, OutputKind.ExportEquals);
    }

    //exported for tests, possibly dtsgen?
    export function generateTypesForModuleAsString(name: string, moduleValue: unknown): string | undefined {
        const outputStatements = generateTypesForModule(name, moduleValue);
        return outputStatements && textChanges.getNewFileText(outputStatements, "\n", formatting.getFormatContext(testFormatSettings));
    }

    //name, usemore
    function stackify<T>(obj: unknown, name: string, cbOk: () => T, cbFail: () => T): T {
        if (walkStack.has(obj) || keyStack.length > 4) {
            return cbFail();
        }

        walkStack.add(obj);
        keyStack.push(name);
        const res = cbOk();
        keyStack.pop();
        walkStack.delete(obj);
        return res;
    }

    const keyStack: string[] = []; //TODO: not global
    const walkStack = new Set<any>();//todo: not global
    function getValueInfo(name: string, obj: unknown, isRoot = false): ValueInfo | undefined {
        //We'll handle "Default" specially.
        if (!isValidIdentifier(name) && name !== "default") return undefined;

        return stackify(obj, name,
            (): ValueInfo => {
                if (typeof obj === "function") return getFunctionOrClassInfo(obj as AnyFunction, name);
                if (typeof obj === "object" && !getBuiltinType(obj as object)) {
                    const entries = getEntriesOfObject(obj as object);
                    if (isRoot || entries.some(({ value }) => typeof value === "function")) {
                        return { kind: ValueKind.Namespace, name, members: flatMap(entries, ({ key, value }) => getValueInfo(key, value)) }
                    }
                }
                return { kind: ValueKind.Const, name, type: getTypeOfValue(obj), comment: undefined };
            },
            (): ValueInfo => ({ kind: ValueKind.Const, name, type: create.anyType(), comment: ` ${walkStack.has(obj) ? 'Circular reference' : 'Too-deep object hierarchy'} from ${keyStack.join('.')}` }));
    }

    const enum ValueKind { Const, Function, Class, Namespace }
    interface ValueInfoBase { readonly name: string; }
    type ValueInfo = ConstInfo | FunctionInfo | ClassInfo | NamespaceInfo;
    interface ConstInfo extends ValueInfoBase { readonly kind: ValueKind.Const; readonly type: TypeNode; readonly comment: string | undefined; }
    interface FunctionInfo extends ValueInfoBase {
        readonly kind: ValueKind.Function;
        readonly parameters: ReadonlyArray<ParameterDeclaration>;
        readonly returnType: TypeNode;
        readonly namespaceMembers: ReadonlyArray<Statement>;
    }
    interface ClassInfo extends ValueInfoBase {
        readonly kind: ValueKind.Class; readonly members: ReadonlyArray<ClassElementLike>; readonly namespaceMembers: ReadonlyArray<Statement> ;
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

    function getFunctionOrClassInfo(obj: AnyFunction, name: string): FunctionInfo | ClassInfo { //name
        const fnAst = parseClassOrFunctionBody(obj) ;
        const { parameters, returnType } = fnAst === undefined ? { parameters: emptyArray, returnType: create.anyType() } : getParameterListAndReturnType(obj, fnAst);
        const classNonStaticMembers = [...(fnAst ? getConstructorFunctionInstanceMembers(fnAst) : emptyArray), ...getPrototypeMembers(obj)];

        const classStaticMembers: ClassElementLike[] | undefined =
            //If !fnAst, this is a class (with no declared constructor)
            classNonStaticMembers.length !== 0 || !fnAst || fnAst.kind === SyntaxKind.Constructor ? [] : undefined;
        const namespaceMembers = flatMap(getEntriesOfObject(obj), ({ key, value }) => {
            const info = getValueInfo(key, value);
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

    const builtins: { readonly [name: string]: (new (...args: unknown[]) => unknown) | undefined } = { Date, RegExp, Map, Set }; //HTMLElement: (typeof HTMLElement !== 'undefined') ? HTMLElement : undefined, //todo
    function getBuiltinType(value: object): TypeNode | undefined {
        if (Array.isArray(value)) {
            return createArrayTypeNode(value.length
                ? stackify(value[0], "0", () => getTypeOfValue(value[0]), () => create.anyType())
                : create.anyType());
        }
        for (const builtinName in builtins) {
            if (builtins[builtinName] && value instanceof builtins[builtinName]!) {
                return create.typeReference(builtinName);
            }
        }
    }

    function getTypeOfValue(value: unknown): TypeNode {
        if (value == null) return create.anyType();
        const to = typeof value;
        if (to !== "object") {
            //fn may happen for array with function as first element. But usually handled outside. (TEST)
            return to === "function" ? create.typeReference("Function") : createKeywordTypeNode(ts.stringToToken(to) as KeywordTypeNode["kind"]);
        }
        return getTypeOfObject(value as object);
    }

    function getTypeOfObject(value: object): TypeNode {
        const s = getBuiltinType(value as object); //name
        if (s) return s;

        walkStack.add(value);
        const members = getEntriesOfObject(value as object).map(({ key, value }) =>
            create.propertySignature(key, walkStack.has(value) ? create.anyType() : getTypeOfValue(value)));
        walkStack.delete(value);
        return createTypeLiteralNode(members);
    }

    // Parses assignments to 'this.x' in the constructor into class property declarations
    function getConstructorFunctionInstanceMembers(fnAst: FunctionOrConstructor): ReadonlyArray<PropertyDeclaration> {
        const members: PropertyDeclaration[] = [];
        forEachOwnNodeOfFunction(fnAst, node => {
            if (ts.isAssignmentExpression(node, /*excludeCompoundAssignment*/ true) &&
                isPropertyAccessExpression(node.left) && node.left.expression.kind === ts.SyntaxKind.ThisKeyword) {
                const name = node.left.name.text;
                if (!isJsPrivate(name)) members.push(create.property(/*modifier*/ undefined, name, create.anyType()));
            }
        });
        return members;
    }

    function getPrototypeMembers(fn: AnyFunction): ReadonlyArray<MethodDeclaration> {
        return !fn.prototype ? emptyArray : mapDefined(Object.getOwnPropertyNames(fn.prototype).sort(), name => {
            if (name === "constructor" || isJsPrivate(name)) return undefined;
            const obj = Object.getOwnPropertyDescriptor(fn.prototype, name)!.value;
            const fnAst = parseClassOrFunctionBody(obj as AnyFunction);
            if (!fnAst) return;
            const { parameters, returnType } = getParameterListAndReturnType(obj as AnyFunction, fnAst);
            const comment = isNativeFunction(obj as AnyFunction) ? ' Native method; no parameter or return type inference available' : undefined;
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
            hasReturn = hasReturn || isReturnStatement(node) && !!node.expression && node.expression.kind !== ts.SyntaxKind.VoidExpression;
        });
        const parameters = fnAst.parameters
            ? [
                ...fnAst.parameters.map(p => create.parameter(`${p.name.getText()}`, inferParameterType(fnAst, p))),
                ...(usedArguments ? [create.restParameter('args', createArrayTypeNode(create.anyType()))] : emptyArray),
            ]
            : [create.restParameter('args', createArrayTypeNode(create.anyType()))];
        return { parameters, returnType: hasReturn ? create.anyType() : create.voidType() };
    }

    //name
    type FunctionOrConstructor = FunctionExpression | ArrowFunction | ConstructorDeclaration | MethodDeclaration;
    function parseClassOrFunctionBody(fn: AnyFunction): FunctionOrConstructor | undefined {
        //(function(){}).toString() is `function() {}`
        //(() => 0).toString() is `() => 0`
        //(x => x).toString() is `x => x`
        //(class{}).toString() is `class{}`
        //`(class{ constructor(p) {} m() {} }).toString()` is the class source -- means we can parse the constructor.
        //(class{ m() {} }).prototype.m.toString() is `m() {}`
        //  similarly, ({ m() {} }).m.toString() is `m() {}`

        //Therefore, we know it will begin with `function`, `class`, `(`, or a method name.
        const str = fn.toString();
        //if (str.startsWith("function") || str.startsWith("(") || str.startsWith("class")) {
        const expr = parseExpression(str);
        const classOrFunction = tryCast(expr, (node): node is FunctionExpression | ArrowFunction | ClassExpression => isFunctionExpression(node) || isArrowFunction(node) || isClassExpression(node));
        if (classOrFunction) {
            return classOrFunction.kind === SyntaxKind.ClassExpression ? find(classOrFunction.members, isConstructorDeclaration) : classOrFunction;
        }
        else {
            //it's a method `m() {}`
            return cast(first(cast(parseExpression(`{ ${str} }`), isObjectLiteralExpression).properties), isMethodDeclaration);
        }
    }

    function parseExpression(expr: string): Expression {
        const text = `const _ = ${expr}`;
        const srcFile = createSourceFile("test.ts", text, ScriptTarget.Latest, /*setParentNodes*/ true);
        return first(cast(first(srcFile.statements), isVariableStatement).declarationList.declarations).initializer!;
    }

    function isNativeFunction(fn: AnyFunction): boolean {
        return stringContains(fn.toString(), '{ [native code] }');
    }

    function inferParameterType(_fn: FunctionOrConstructor, _param: ts.ParameterDeclaration): TypeNode {
        // TODO: Inspect function body for clues (see inferFromUsage.ts)
        return create.anyType();
    }

    // Descends through all nodes in a function, but not in nested functions.
    function forEachOwnNodeOfFunction(fnAst: FunctionOrConstructor, cb: (node: Node) => void) {
        fnAst.body!.forEachChild(node => {
            cb(node);
            if (!ts.isFunctionLike(node)) node.forEachChild(cb);
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
            keys.filter(k => k[0] !== '_' && !ignoredProperties.has(k) && (typeof obj !== "function" || !reservedFunctionProperties.has(k))),
            ts.compareStringsCaseSensitive);
    }

    //mv?
    function isValidIdentifier(name: string): boolean {
        const keyword = ts.stringToToken(name);
        return !(keyword && ts.isNonContextualKeyword(keyword)) && ts.isIdentifierText(name, ScriptTarget.ESNext);
    }
}
