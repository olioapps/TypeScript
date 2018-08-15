/* @internal */
namespace ts {
    export function generateTypesForModule(packageName: string, moduleValue: unknown): ReadonlyArray<Statement> | undefined {
        const vi = getValueInfo(codefix.moduleSpecifierToValidIdentifier(packageName, ScriptTarget.ESNext), moduleValue); //name
        return vi && toStatements(vi, OutputKind.ExportEquals);
    }

    const keyStack: string[] = []; //TODO: not global
    const walkStack = new Set<any>();//todo: not global
    function getValueInfo(name: string, obj: unknown): ValueInfo | undefined {
        if (walkStack.has(obj) || keyStack.length > 4) {
            //Circular or too-deep reference
            return { kind: ValueKind.Const, name, type: create.any(), comment: `${walkStack.has(obj) ? 'Circular reference' : 'Too-deep object hierarchy'} from ${keyStack.join('.')}` }
        }

        if (!ts.isIdentifierText(name, ts.ScriptTarget.ESNext)) return undefined;

        walkStack.add(obj);
        keyStack.push(name);
        const res: ValueInfo = typeof obj === "function" ? getFunctionOrClassInfo(obj as AnyFunction, name)
            : typeof obj === "object" ?  getObjectInfo(obj as object, name)
            : { kind: ValueKind.Const, name, type: typeFromTypeof(obj), comment: undefined };
        keyStack.pop();
        walkStack.delete(obj);
        return res;
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
    function toNamespaceMemberStatements(v: ValueInfo): ReadonlyArray<Statement> { return toStatements(v, OutputKind.NamespaceMember); }
    function toStatements(v: ValueInfo, kind: OutputKind): ReadonlyArray<Statement> {
        const mod = kind === OutputKind.ExportEquals ? SyntaxKind.DeclareKeyword : kind === OutputKind.NamedExport ? SyntaxKind.ExportKeyword : undefined;
        const exportEquals = kind === OutputKind.ExportEquals ? [create.exportEquals(v.name)] : emptyArray;
        switch (v.kind) {
            case ValueKind.Const: {
                const { name, type, comment } = v;
                return [...exportEquals, create.constVar(mod, name, type, comment)];
            }
            case ValueKind.Function: {
                const { name, parameters, returnType, namespaceMembers } = v;
                return [...exportEquals, create.fn(mod, name, parameters, returnType), ...ns2(name, namespaceMembers, mod)];
            }
            case ValueKind.Class: {
                const { name, members, namespaceMembers } = v;
                return [...exportEquals, create.cls(mod, name, members), ...ns2(name, namespaceMembers, mod)];
            }
            case ValueKind.Namespace: {
                const { name, members } = v;
                return kind === OutputKind.ExportEquals
                    ? flatMap(members, v => toStatements(v, OutputKind.NamedExport))
                    : [create.namespace(mod, name, flatMap(members, toNamespaceMemberStatements))];
            }
            default:
                return Debug.assertNever(v);
        }
    }
    //name
    function ns2(name: string, namespaceMembers: ReadonlyArray<Statement>, mod: Modifier["kind"] | undefined): ReadonlyArray<Statement> {
        return namespaceMembers.length === 0 ? emptyArray : [create.namespace(mod, name, namespaceMembers)];
    }
    //name
    function ns2Declare(name: string, namespaceMembers: ReadonlyArray<Statement>): NamespaceDeclaration {
        return create.namespace(SyntaxKind.DeclareKeyword, name, namespaceMembers);
    }

    function getFunctionOrClassInfo(obj: AnyFunction, name: string): FunctionInfo | ClassInfo { //name
        const fnAst = parseClassOrFunctionBody(obj) ;
        const { parameters, returnType } = fnAst === undefined ? { parameters: emptyArray, returnType: create.any() } : getParameterListAndReturnType(obj, fnAst);
        const classNonStaticMembers = [...(fnAst ? getConstructorFunctionInstanceMembers(fnAst) : emptyArray), ...getPrototypeMembers(obj)];

        const classStaticMembers: ClassElementLike[] | undefined =
            //If !fnAst, this is a class (with no declared constructor)
            classNonStaticMembers.length !== 0 || !fnAst || fnAst.kind === SyntaxKind.FunctionExpression ? [] : undefined;
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
                        classStaticMembers.push(create.method(SyntaxKind.StaticKeyword, name, parameters, returnType, /*comment*/ undefined));
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

    function getObjectInfo(obj: object, name: string): ConstInfo | NamespaceInfo {
        const entries = getEntriesOfObject(obj);
        const hasClassOrFunction = entries.some(({ value }) => typeof value === "function");
        return hasClassOrFunction
            ? { kind: ValueKind.Namespace, name, members: flatMap(entries, ({ key, value }) => getValueInfo(key, value)) }
            : { kind: ValueKind.Const, name, type: getTypeOfValue(obj), comment: undefined }
    }

    //neater (check uses)
    const builtins: { readonly [name: string]: (new (...args: unknown[]) => unknown) | undefined } = {
        Date,
        RegExp,
        Map: (typeof Map !== 'undefined') ? Map : undefined,
        //HTMLElement: (typeof HTMLElement !== 'undefined') ? HTMLElement : undefined, //todo
    };
    function getTypeOfValue(value: unknown): TypeNode {
        //todo: do better for "function" here? this is the case if it has something that has a function. module.exports = { a: { b: function() {} } };
        if (typeof value !== "object" || value === null) return typeFromTypeof(value);

        if (Array.isArray(value)) return createArrayTypeNode(value.length ? getTypeOfValue(value[0]) : create.any());

        for (const builtinName in builtins) {
            if (builtins[builtinName] && value instanceof builtins[builtinName]!) {
                return create.typeReference(builtinName);
            }
        }

        walkStack.add(value);
        const members = getPropertyDeclarationsOfObject(value as object);
        walkStack.delete(value);
        return createTypeLiteralNode(members);
    }

    function typeFromTypeof(obj: unknown): TypeNode {
        const to = typeof obj;
        if (to === "function") return create.typeReference("Function");
        return createKeywordTypeNode((() => {
            switch (to) {
                case "boolean": return SyntaxKind.BooleanKeyword;
                case "number": return SyntaxKind.NumberKeyword;
                case "string": return SyntaxKind.StringKeyword;
                case "symbol": return SyntaxKind.SymbolKeyword;
                case "undefined": return SyntaxKind.AnyKeyword;
                case "object": return obj === null ? SyntaxKind.AnyKeyword : SyntaxKind.ObjectKeyword;
                default: return Debug.assertNever(to);
            }
        })());
    }

    function getPropertyDeclarationsOfObject(obj: object): ReadonlyArray<PropertySignature> {
        walkStack.add(obj);
        const result = getEntriesOfObject(obj).map(({ key, value }) =>
            create.propertySignature(key, walkStack.has(value) ? create.any() : getTypeOfValue(value)));
        walkStack.delete(obj);
        return result;
    }

    // Parses assignments to 'this.x' in the constructor into class property declarations
    function getConstructorFunctionInstanceMembers(fnAst: FunctionOrConstructor): ReadonlyArray<PropertyDeclaration> {
        const members: PropertyDeclaration[] = [];
        forEachOwnNodeOfFunction(fnAst, node => {
            if (ts.isAssignmentExpression(node, /*excludeCompoundAssignment*/ true) &&
                isPropertyAccessExpression(node.left) && node.left.expression.kind === ts.SyntaxKind.ThisKeyword) {
                members.push(create.property(/*modifier*/ undefined, node.left.name.text, create.any(), /*comment*/ undefined));
            }
        });
        return members;
    }

    function getPrototypeMembers(ctor: AnyFunction): ReadonlyArray<MethodDeclaration> {
        return mapDefined(Object.getOwnPropertyNames(ctor.prototype).sort(), name => {
            if (name === "constructor" || name.startsWith("_")) return undefined;
            const obj = Object.getOwnPropertyDescriptor(ctor.prototype, name)!.value;
            const fnAst = parseClassOrFunctionBody(obj as AnyFunction);
            if (!fnAst) return;
            const { parameters, returnType } = getParameterListAndReturnType(obj as AnyFunction, fnAst);
            const comment = isNativeFunction(obj as AnyFunction) ? 'Native method; no parameter or return type inference available' : undefined;
            return create.method(/*modifier*/ undefined, name, parameters, returnType, comment);
        });
    }

    function getParameterListAndReturnType(obj: AnyFunction, fnAst: FunctionOrConstructor): { readonly parameters: ReadonlyArray<ParameterDeclaration>, readonly returnType: TypeNode } {
        if (isNativeFunction(obj)) {
            return { parameters: fill(obj.length, i => create.parameter(`p${i}`, create.any())), returnType: create.any() };
        }
        let usedArguments = false, hasReturn = false;
        forEachOwnNodeOfFunction(fnAst, node => {
            usedArguments = usedArguments || isIdentifier(node) && node.text === "arguments";
            hasReturn = hasReturn || isReturnStatement(node) && !!node.expression && node.expression.kind !== ts.SyntaxKind.VoidExpression;
        });
        const parameters = fnAst.parameters
            ? [
                ...fnAst.parameters.map(p => create.parameter(`${p.name.getText()}`, inferParameterType(fnAst, p))),
                ...(usedArguments ? [create.restParameter('args', createArrayTypeNode(create.any()))] : emptyArray),
            ]
            : [create.restParameter('args', createArrayTypeNode(create.any()))];
        return { parameters, returnType: hasReturn ? create.any() : create.voidType() };
    }

    type FunctionOrConstructor = FunctionExpression | ConstructorDeclaration;
    function parseClassOrFunctionBody(fn: AnyFunction): FunctionOrConstructor | undefined {
        const text = `const _ = ${fn.toString()};`;
        const srcFile = createSourceFile("test.ts", text, ScriptTarget.Latest, /*setParentNodes*/ true);
        const expr = first(cast(first(srcFile.statements), isVariableStatement).declarationList.declarations).initializer!;
        const classOrFunction = cast(expr, (node): node is FunctionExpression | ClassExpression => isFunctionExpression(node) || isClassExpression(node));
        return classOrFunction.kind === SyntaxKind.FunctionExpression ? classOrFunction : find(classOrFunction.members, isConstructorDeclaration);
    }

    function isNativeFunction(fn: AnyFunction): boolean {
        return stringContains(fn.toString(), '{ [native code] }');
    }

    function inferParameterType(_fn: FunctionOrConstructor, _param: ts.ParameterDeclaration): TypeNode {
        // TODO: Inspect function body for clues (see inferFromUsage.ts)
        return create.any();
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

    namespace create {
        export type Modifiers = Modifier["kind"] | undefined;
        function toModifiers(modifier: Modifiers): ReadonlyArray<Modifier> | undefined {
            return modifier === undefined ? undefined : [createModifier(modifier) as Modifier]
        }

        export function constVar(modifiers: Modifiers, name: string, type: TypeNode, comment: string | undefined): VariableStatement {
            comment;//TODO
            return createVariableStatement(
                toModifiers(modifiers),
                createVariableDeclarationList([createVariableDeclaration(name, type)], NodeFlags.Const));
        }
        export function any(): KeywordTypeNode {
            return createKeywordTypeNode(SyntaxKind.AnyKeyword)
        }
        export function voidType(): KeywordTypeNode {
            return createKeywordTypeNode(SyntaxKind.VoidKeyword);
        }
        export function typeReference(name: string): TypeReferenceNode {
            return createTypeReferenceNode(name, /*typeArguments*/ undefined);
        }
        export function fn(modifiers: Modifiers, name: string, parameters: ReadonlyArray<ParameterDeclaration>, returnType: TypeNode): FunctionDeclaration {
            return createFunctionDeclaration(/*decorators*/ undefined, toModifiers(modifiers), /*asteriskToken*/ undefined, name, /*typeParameters*/ undefined, parameters, returnType, /*body*/ undefined);
        }
        export function cls(modifiers: Modifiers, name: string, elements: ReadonlyArray<ClassElement>): ClassDeclaration {
            return createClassDeclaration(/*decorators*/ undefined, toModifiers(modifiers), name, /*typeParameters*/ undefined, /*heritageClauses*/ undefined, elements);
        }
        export function ctr(parameters: ReadonlyArray<ParameterDeclaration>): ConstructorDeclaration {
            return createConstructor(/*decorators*/ undefined, /*modifiers*/ undefined, parameters, /*body*/ undefined);
        }
        export function parameter(name: string, type: TypeNode): ParameterDeclaration {
            return createParameter(/*decorators*/ undefined, /*modifiers*/ undefined, /*dotDotDotToken*/ undefined, name, /*questionToken*/ undefined, type, /*initializer*/ undefined);
        }
        export function restParameter(name: string, type: TypeNode): ParameterDeclaration {
            return createParameter(/*decorators*/ undefined, /*modifiers*/ undefined, /*dotDotDotToken*/ createToken(SyntaxKind.DotDotDotToken), name, /*questionToken*/ undefined, type, /*initializer*/ undefined);
        }
        export function method(modifier: Modifiers, name: string, parameters: ReadonlyArray<ParameterDeclaration>, returnType: TypeNode, comment: string | undefined): MethodDeclaration {
            comment; //todo
            return createMethod(
                /*decorators*/ undefined,
                toModifiers(modifier),
                /*asteriskToken*/ undefined,
                name,
                /*questionToken*/ undefined,
                /*typeParameters*/ undefined,
                parameters,
                returnType,
                /*body*/ undefined);
        }
        export function property(modifier: Modifier["kind"] | undefined, name: string, type: TypeNode, comment: string | undefined): PropertyDeclaration {
            comment; //todo
            return createProperty(/*decorators*/ undefined, toModifiers(modifier), name, /*questionOrExclamationToken*/ undefined, type, /*initializer*/ undefined);
        }
        export function propertySignature(name: string, type: TypeNode): PropertySignature {
            return createPropertySignature(/*modifiers*/ undefined, name, /*questionToken*/ undefined, type, /*initializer*/ undefined);
        }
        export function namespace(modifier: Modifier["kind"] | undefined, name: string, statements: ReadonlyArray<Statement>): NamespaceDeclaration {
            return createModuleDeclaration(/*decorators*/ undefined, toModifiers(modifier), createIdentifier(name), createModuleBlock(statements)) as NamespaceDeclaration;
        }
        export function exportEquals(name: string): ExportAssignment {
            return createExportAssignment(/*decorators*/ undefined, /*modifiers*/ undefined, /*isExportEquals*/ true, createIdentifier(name));
        }
    }
}