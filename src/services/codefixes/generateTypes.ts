/* @internal */
namespace ts {
    export function generateTypesForModule(name: string, moduleValue: unknown): string {
        return valueInfoToDeclarationFileText(inspectValue(name, moduleValue));
    }

    export function valueInfoToDeclarationFileText(valueInfo: ValueInfo): string {
        return textChanges.getNewFileText(toStatements(valueInfo, OutputKind.ExportEquals), "\n", formatting.getFormatContext(testFormatSettings));
    }

    const enum OutputKind { ExportEquals, NamedExport, NamespaceMember }
    function toNamespaceMemberStatements(info: ValueInfo): ReadonlyArray<Statement> {
        return toStatements(info, OutputKind.NamespaceMember);
    }
    function toStatements(info: ValueInfo, kind: OutputKind): ReadonlyArray<Statement> {
        const isDefault = info.name === InternalSymbolName.Default;
        const name = isDefault ? "_default" : info.name;
        if (!isValidIdentifier(name) || isDefault && kind !== OutputKind.NamedExport) return emptyArray;

        const modifiers: create.Modifiers = isDefault && info.kind === ValueKind.FunctionOrClass
            ? [SyntaxKind.ExportKeyword, SyntaxKind.DefaultKeyword]
            : kind === OutputKind.ExportEquals ? SyntaxKind.DeclareKeyword : kind === OutputKind.NamedExport ? SyntaxKind.ExportKeyword : undefined;
        const exportEquals = () => kind === OutputKind.ExportEquals ? [create.exportEquals(info.name)] : emptyArray;
        const exportDefault = () => isDefault ? [create.exportDefault("_default")] : emptyArray;

        switch (info.kind) {
            case ValueKind.FunctionOrClass:
                return [...exportEquals(), ...functionOrClassToStatements(modifiers, name, info)];
            case ValueKind.Object:
                const { members } = info;
                if (kind === OutputKind.ExportEquals) {
                    return flatMap(members, v => toStatements(v, OutputKind.NamedExport));
                }
                if (members.some(m => m.kind === ValueKind.FunctionOrClass)) {
                    // If some member is a function, use a namespace so it gets a FunctionDeclaration or ClassDeclaration.
                    return [...exportDefault(), create.namespace(modifiers, name, flatMap(members, toNamespaceMemberStatements))];
                }
                // falls through
            case ValueKind.Const:
            case ValueKind.Array:
                return [...exportEquals(), ...exportDefault(), create.constVar(modifiers, name, toType(info), info.kind === ValueKind.Const ? info.comment : undefined)];
            default:
                return Debug.assertNever(info); //unnecessary now?
        }
    }

    function functionOrClassToStatements(modifiers: create.Modifiers, name: string, { source, prototypeMembers, namespaceMembers }: ValueInfoFunctionOrClass): ReadonlyArray<Statement> {
        const fnAst = parseClassOrFunctionBody(source);
        const { parameters, returnType } = fnAst === undefined ? { parameters: emptyArray, returnType: create.anyType() } : getParametersAndReturnType(fnAst);
        const instanceMembers = typeof fnAst === "object" ? getConstructorFunctionInstanceMembers(fnAst) : emptyArray;
        // ignore non-functions on the prototype
        const protoMembers = mapDefined(prototypeMembers, info => info.kind === ValueKind.FunctionOrClass ? tryGetMethod(info) : undefined);
        const classNonStaticMembers: ReadonlyArray<ClassElement> = [...instanceMembers, ...protoMembers];

        const classStaticMembers: ClassElementLike[] | undefined =
            classNonStaticMembers.length !== 0 || !fnAst || typeof fnAst !== "number" && fnAst.kind === SyntaxKind.Constructor ? [] : undefined;

        const namespaceStatements = flatMap(namespaceMembers, info => {
            if (classStaticMembers) {
                switch (info.kind) {
                    case ValueKind.Object:
                        if (info.members.some(m => m.kind === ValueKind.FunctionOrClass)) {
                            break;
                        }
                        // falls through
                    case ValueKind.Array:
                    case ValueKind.Const:
                        classStaticMembers.push(create.property(SyntaxKind.StaticKeyword, info.name, toType(info), info.kind === ValueKind.Const ? info.comment : undefined));
                        return undefined;
                    case ValueKind.FunctionOrClass:
                        if (!info.namespaceMembers.length) { // Else, can't merge a static method with a namespace. Must make it a function on the namespace.
                            const sig = tryGetMethod(info, SyntaxKind.StaticKeyword);
                            if (sig) {
                                classStaticMembers.push(sig);
                                return undefined;
                            }
                        }
                }
            }
            return toStatements(info, OutputKind.NamespaceMember);
        });

        const decl = classStaticMembers
            ? create.cls(modifiers, name, [...classStaticMembers, ...(parameters.length ? [create.ctr(parameters)] : emptyArray), ...classNonStaticMembers])
            : create.fn(modifiers, name, parameters, returnType);
        return [decl, ...(namespaceStatements.length === 0 ? emptyArray : [create.namespace(modifiers, name, namespaceStatements)])];
    }

    function tryGetMethod({ name, source }: ValueInfoFunctionOrClass, modifiers?: create.Modifiers): MethodDeclaration | undefined {
        const fnAst = parseClassOrFunctionBody(source);
        if (!fnAst || (typeof fnAst !== "number" && fnAst.kind === SyntaxKind.Constructor)) return undefined;
        const sig = getParametersAndReturnType(fnAst);
        return sig && create.method(modifiers, name, sig.parameters, sig.returnType);
    }

    function toType(info: ValueInfo): TypeNode {
        switch (info.kind) {
            case ValueKind.Const:
                return create.typeReference(info.typeName);
            case ValueKind.Array:
                return createArrayTypeNode(toType(info.inner));
            case ValueKind.FunctionOrClass:
                return create.typeReference("Function"); // Normally we create a FunctionDeclaration, but this can happen for a function in an array.
            case ValueKind.Object:
                return createTypeLiteralNode(info.members.map(m => create.propertySignature(m.name, toType(m))));
            default:
                return Debug.assertNever(info); //necessary with new lkg?
        }
    }

    // Parses assignments to "this.x" in the constructor into class property declarations
    function getConstructorFunctionInstanceMembers(fnAst: FunctionOrConstructorNode): ReadonlyArray<PropertyDeclaration> {
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

    interface ParametersAndReturnType { readonly parameters: ReadonlyArray<ParameterDeclaration>; readonly returnType: TypeNode; }
    function getParametersAndReturnType(fnAst: FunctionOrConstructor): ParametersAndReturnType {
        if (typeof fnAst === "number") {
            return { parameters: fill(fnAst, i => create.parameter(`p${i}`, create.anyType())), returnType: create.anyType() };
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

    type FunctionOrConstructorNode = FunctionExpression | ArrowFunction | ConstructorDeclaration | MethodDeclaration;
    type FunctionOrConstructor = FunctionOrConstructorNode | number; // number is for native function
    /** Returns 'undefined' for class with no declared constructor */
    function parseClassOrFunctionBody(source: string | number): FunctionOrConstructor | undefined {
        if (typeof source === "number") return source;
        const classOrFunction = tryCast(parseExpression(source), (node): node is FunctionExpression | ArrowFunction | ClassExpression => isFunctionExpression(node) || isArrowFunction(node) || isClassExpression(node));
        return classOrFunction
            ? isClassExpression(classOrFunction) ? find(classOrFunction.members, isConstructorDeclaration) : classOrFunction
            // If that didn't parse, it's a method `m() {}`. Parse again inside of an object literal.
            : cast(first(cast(parseExpression(`{ ${source} }`), isObjectLiteralExpression).properties), isMethodDeclaration);
    }

    function parseExpression(expr: string): Expression {
        const text = `const _ = ${expr}`;
        const srcFile = createSourceFile("test.ts", text, ScriptTarget.Latest, /*setParentNodes*/ true);
        return first(cast(first(srcFile.statements), isVariableStatement).declarationList.declarations).initializer!;
    }

    function inferParameterType(_fn: FunctionOrConstructor, _param: ParameterDeclaration): TypeNode {
        // TODO: Inspect function body for clues (see inferFromUsage.ts)
        return create.anyType();
    }

    // Descends through all nodes in a function, but not in nested functions.
    function forEachOwnNodeOfFunction(fnAst: FunctionOrConstructorNode, cb: (node: Node) => void) {
        fnAst.body!.forEachChild(function recur(node) {
            cb(node);
            if (!isFunctionLike(node)) node.forEachChild(recur);
        });
    }

    function isValidIdentifier(name: string): boolean {
        const keyword = stringToToken(name);
        return !(keyword && isNonContextualKeyword(keyword)) && isIdentifierText(name, ScriptTarget.ESNext);
    }
}
