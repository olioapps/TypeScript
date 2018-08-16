/* @internal */
namespace ts {
    export function generateTypesForModule(name: string, moduleValue: unknown): string | undefined {
        const outputStatements = generateTypesForModuleAsStatements(name, moduleValue);
        return outputStatements && textChanges.getNewFileText(outputStatements, "\n", formatting.getFormatContext(testFormatSettings));
    }

    //kill
    export function generateTypesForModuleAsStatements(packageName: string, moduleValue: unknown): ReadonlyArray<Statement> | undefined {
        const info = getValueInfo(codefix.moduleSpecifierToValidIdentifier(packageName, ScriptTarget.ESNext), moduleValue, getRecurser(), /*isRoot*/ true);
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
        };
    }

    function getValueInfo(name: string, value: unknown, recurser: Recurser, isRoot = false): ValueInfo | undefined {
        if (!isValidIdentifier(name) && name !== "default") return undefined; // "default" handled specially in `toStatements`
        return recurser(value, name,
            (): ValueInfo => {
                if (typeof value === "function") return getFunctionOrClassInfo(value as AnyFunction, name, recurser);
                if (typeof value === "object" && !isBuiltinType(value as object)) {
                    const entries = getEntriesOfObject(value as object);
                    if (isRoot || entries.some(({ value }) => typeof value === "function")) {
                        return { kind: ValueKind.Namespace, name, members: flatMap(entries, ({ key, value }) => getValueInfo(key, value, recurser)) };
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
        readonly namespaceMembers: ReadonlyArray<ValueInfo>;
    }
    interface ClassInfo extends ValueInfoBase {
        readonly kind: ValueKind.Class;
        readonly members: ReadonlyArray<ClassElementLike>;
        readonly namespaceMembers: ReadonlyArray<ValueInfo>;
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
        let { name } = v;
        const isDefault = name === InternalSymbolName.Default;
        if (isDefault) {
            if (kind !== OutputKind.NamedExport) return emptyArray;
            if (v.kind === ValueKind.Function || v.kind === ValueKind.Class) {
                mod = [SyntaxKind.ExportKeyword, SyntaxKind.DefaultKeyword];
            }
            name = "_default";
        }

        const exportEquals = () => kind === OutputKind.ExportEquals ? [create.exportEquals(v.name)] : emptyArray;
        const exportDefault = () => isDefault ? [create.exportDefault("_default")] : emptyArray;

        switch (v.kind) {
            case ValueKind.Const: {
                const { type, comment } = v;
                return [...exportEquals(), ...exportDefault(), create.constVar(mod, name, type, comment)];
            }
            case ValueKind.Function: {
                const { parameters, returnType, namespaceMembers } = v;
                return [...exportEquals(), create.fn(mod, name, parameters, returnType), ...tryCreateNamespace(name, namespaceMembers, mod)];
            }
            case ValueKind.Class: {
                const { members, namespaceMembers } = v;
                return [...exportEquals(), create.cls(mod, name, members), ...tryCreateNamespace(name, namespaceMembers, mod)];
            }
            case ValueKind.Namespace: {
                const { members } = v;
                return kind === OutputKind.ExportEquals
                    ? flatMap(members, v => toStatements(v, OutputKind.NamedExport))
                    : [...exportDefault(), create.namespace(mod, name, flatMap(members, toNamespaceMemberStatements))];
            }
            default:
                return Debug.assertNever(v);
        }
    }
    function tryCreateNamespace(name: string, namespaceMembers: ReadonlyArray<ValueInfo>, mod: create.Modifiers): ReadonlyArray<Statement> {
        return namespaceMembers.length === 0 ? emptyArray : [create.namespace(mod, name, flatMap(namespaceMembers, toNamespaceMemberStatements))];
    }

    function getFunctionOrClassInfo(obj: AnyFunction, name: string, recurser: Recurser): FunctionInfo | ClassInfo {
        const fnAst = parseClassOrFunctionBody(obj) ;
        const { parameters, returnType } = fnAst === undefined ? { parameters: emptyArray, returnType: create.anyType() } : getParameterListAndReturnType(obj, fnAst);
        const classNonStaticMembers = [...(fnAst ? getConstructorFunctionInstanceMembers(fnAst) : emptyArray), ...getPrototypeMembers(obj)];

        const classStaticMembers: ClassElementLike[] | undefined =
            classNonStaticMembers.length !== 0 || !fnAst || fnAst.kind === SyntaxKind.Constructor ? [] : undefined;
        const namespaceMembers = flatMap(getEntriesOfObject(obj), ({ key, value }) => {
            const info = getValueInfo(key, value, recurser);
            if (classStaticMembers && info) {
                switch (info.kind) {
                    case ValueKind.Const: {
                        const { name, type, comment } = info;
                        classStaticMembers.push(create.property(SyntaxKind.StaticKeyword, name, type, comment));
                        return undefined;
                    }
                    case ValueKind.Function: {
                        const { name, parameters, returnType, namespaceMembers: itsNamespaceMembers } = info;
                        if (!itsNamespaceMembers.length) {
                            classStaticMembers.push(create.method(SyntaxKind.StaticKeyword, name, parameters, returnType));
                            return undefined;
                        }
                        // Else, can't merge a static method with a namespace. Must make it a function on the namespace.
                    }
                }
            }
            return info;
        });

        if (classStaticMembers) {
            const members = [...classStaticMembers, ...(parameters.length === 0 ? emptyArray : [create.ctr(parameters)]), ...classNonStaticMembers];
            return { kind: ValueKind.Class, name, members, namespaceMembers };
        }
        else {
            return { kind: ValueKind.Function, name, parameters, returnType, namespaceMembers };
        }
    }

    type AnyConstructor = new (...args: unknown[]) => unknown; //move
    const builtins: () => ReadonlyMap<AnyConstructor> = memoize(() => {
        const map = createMap<AnyConstructor>();
        for (const { key, value } of getEntriesOfObject(global)) {
            if (typeof value === "function" && typeof value.prototype === "object" && value !== Object) {
                map.set(key, value as AnyConstructor);
            }
        }
        return map;
    });

    function getBuiltinType(value: object, recurser: Recurser): TypeNode | undefined {
        return isArray(value)
            ? createArrayTypeNode(value.length
                ? recurser(value[0], "0", () => getTypeOfValue(value[0], recurser), () => create.anyType())
                : create.anyType())
            : forEachEntry(builtins(), (builtin, builtinName) => value instanceof builtin ? create.typeReference(builtinName) : undefined);
    }

    function isBuiltinType(value: object): boolean {
        return isArray(value) || !!forEachEntry(builtins(), b => value instanceof b);
    }

    function getTypeOfValue(value: unknown, recurser: Recurser): TypeNode {
        return isNullOrUndefined(value) ? create.anyType() :
            typeof value === "object" ? getBuiltinType(value as object, recurser) || createTypeLiteralNode(getEntriesOfObject(value as object).map(({ key, value }) =>
                create.propertySignature(key, recurser(value, key, () => getTypeOfValue(value, recurser), () => create.anyType())))) :
            // Function may happen for array with function as first element.
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
        return !fn.prototype ? emptyArray : mapDefined(fn.prototype === undefined ? undefined : getEntriesOfObject(fn.prototype), ({ key, value }) => {
            if (key === "constructor") return undefined;
            if (typeof value !== "function") return undefined;
            const fnAst = parseClassOrFunctionBody(value as AnyFunction);
            if (!fnAst) return undefined;
            const { parameters, returnType } = getParameterListAndReturnType(value as AnyFunction, fnAst);
            const comment = isNativeFunction(value as AnyFunction) ? " Native method; no parameter or return type inference available" : undefined;
            return create.method(/*modifier*/ undefined, key, parameters, returnType, comment);
        });
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
        const str = functionToString(fn);
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
        return stringContains(functionToString(fn), "{ [native code] }");
    }

    function functionToString(fn: AnyFunction): string {
        return cast(Function.prototype.toString.call(fn), isString);
    }

    function inferParameterType(_fn: FunctionOrConstructor, _param: ParameterDeclaration): TypeNode {
        // TODO: Inspect function body for clues (see inferFromUsage.ts)
        return create.anyType();
    }

    // Descends through all nodes in a function, but not in nested functions.
    function forEachOwnNodeOfFunction(fnAst: FunctionOrConstructor, cb: (node: Node) => void) {
        fnAst.body!.forEachChild(function recur(node) {
            cb(node);
            if (!isFunctionLike(node)) node.forEachChild(recur);
        });
    }

    const ignoredProperties: ReadonlySet<string> = new Set(["arguments", "caller", "constructor", "eval", "super_", "toString"]);
    const reservedFunctionProperties: ReadonlySet<string> = new Set(Object.getOwnPropertyNames(noop));
    interface ObjectEntry { readonly key: string; readonly value: unknown; }
    function getEntriesOfObject(obj: object): ReadonlyArray<ObjectEntry> {
        const entries: ObjectEntry[] = [];
        let chain = obj;
        while (!isNullOrUndefined(chain) && chain !== Object.prototype && chain !== Function.prototype) {
            for (const key of Object.getOwnPropertyNames(chain)) {
                if (!isJsPrivate(key) && !ignoredProperties.has(key) && (typeof obj !== "function" || !reservedFunctionProperties.has(key))) {
                    entries.push({ key, value: Object.getOwnPropertyDescriptor(chain, key)!.value });
                }
            }
            chain = Object.getPrototypeOf(chain);
        }
        return sortAndDeduplicate(entries, (e1, e2) => compareStringsCaseSensitive(e1.key, e2.key));
    }

    function isNullOrUndefined(value: unknown): value is null | undefined {
        return value == null; // tslint:disable-line
    }

    function isValidIdentifier(name: string): boolean {
        const keyword = stringToToken(name);
        return !(keyword && isNonContextualKeyword(keyword)) && isIdentifierText(name, ScriptTarget.ESNext);
    }

    function isJsPrivate(name: string): boolean {
        return name.startsWith("_");
    }
}
