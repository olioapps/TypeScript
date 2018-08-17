/* @internal */
namespace ts {
    //!
    export interface DoGenerateTypesHost extends ModuleResolutionHost {
        writeFile(path: string, contents: string): void;
    }

    export function generateTypesForModule(name: string, moduleValue: unknown): string | undefined {
        const statements = toStatements(inspectValue(name, moduleValue), OutputKind.ExportEquals);
        //const outputStatements = generateTypesForModuleAsStatements(name, moduleValue);
        return textChanges.getNewFileText(statements, "\n", formatting.getFormatContext(testFormatSettings));
    }

    //export function doGenerateTypes({ file, packageName, outputFileName }: GenerateTypesOptions, host: DoGenerateTypesHost): ApplyCodeActionCommandResult {
    //    const moduleValue = requirePackage(file, packageName, host);
    //    const types = generateTypesForModule(packageName, moduleValue);
    //    if (types) {
    //        host.writeFile(outputFileName, types);
    //    }
    //    return { successMessage: `Wrote types to ${outputFileName}` };
    //}

    export function doGenerateTypesFromValueInfo(_: ValueInfo, _outputFileName: string): void {
        throw new Error("TODO");
    }

    const enum OutputKind { ExportEquals, NamedExport, NamespaceMember }
    function toNamespaceMemberStatements(v: ValueInfo): ReadonlyArray<Statement> {
        return toStatements(v, OutputKind.NamespaceMember);
    }
    function toStatements(v: ValueInfo, kind: OutputKind): ReadonlyArray<Statement> {
        let { name } = v;
        if (!isValidIdentifier(name) && name !== "default") return emptyArray;

        const isDefault = name === InternalSymbolName.Default;
        let mod: create.Modifiers = kind === OutputKind.ExportEquals ? SyntaxKind.DeclareKeyword : kind === OutputKind.NamedExport ? SyntaxKind.ExportKeyword : undefined;
        if (isDefault) {
            if (kind !== OutputKind.NamedExport) return emptyArray;
            if (v.kind === ValueKind.FunctionOrClass) {
                mod = [SyntaxKind.ExportKeyword, SyntaxKind.DefaultKeyword]; //do without mutation
            }
            name = "_default";
        }
        const exportEquals = () => kind === OutputKind.ExportEquals ? [create.exportEquals(v.name)] : emptyArray;
        const exportDefault = () => isDefault ? [create.exportDefault("_default")] : emptyArray;

        switch (v.kind) {
            case ValueKind.Const:
            case ValueKind.Array:
                return conzt();
            case ValueKind.FunctionOrClass:
                return [...exportEquals(), ...createFunOrClass(mod, name, v)]
            case ValueKind.Object: {
                const { members } = v;
                return kind === OutputKind.ExportEquals
                    ? flatMap(members, v => toStatements(v, OutputKind.NamedExport))
                    //if some member is a fn/class, use namespace, else use type decl
                    : members.some(m => m.kind === ValueKind.FunctionOrClass)
                        ? [...exportDefault(), create.namespace(mod, name, flatMap(members, toNamespaceMemberStatements))]
                        : conzt();
            }
            default:
                return Debug.assertNever(v);
        }

        //!
        function conzt(): ReadonlyArray<Statement> {
            return [...exportEquals(), ...exportDefault(), create.constVar(mod, name, toType(v), v.kind === ValueKind.Const ? v.comment : undefined)];
        }
    }

    //name
    function createFunOrClass(mod: create.Modifiers, name: string, { source, prototypeMembers, namespaceMembers }: FunctionOrClassInfo): ReadonlyArray<Statement> {
        const fnAst = parseClassOrFunctionBody(source);
        const { parameters, returnType } = fnAst === undefined ? { parameters: emptyArray, returnType: create.anyType() } : getParameterListAndReturnType(fnAst);
        const instanceMembers = typeof fnAst === "object" ? getConstructorFunctionInstanceMembers(fnAst) : emptyArray;
        const classNonStaticMembers: ReadonlyArray<ClassElement> = [...instanceMembers, ...mapDefined(prototypeMembers, toClassNonStaticMember)];

        const classStaticMembers: ClassElementLike[] | undefined =
            classNonStaticMembers.length !== 0 || !fnAst || typeof fnAst !== "number" && fnAst.kind === SyntaxKind.Constructor ? [] : undefined;

        //name
        const namespaceMembers2 = flatMap(namespaceMembers, info => {
            if (classStaticMembers) {
                switch (info.kind) {
                    case ValueKind.Object:
                        if (info.members.some(m => m.kind === ValueKind.FunctionOrClass)) {
                            break; //use a namespace (test)
                        }
                    case ValueKind.Array:
                    case ValueKind.Const:
                        classStaticMembers.push(create.property(SyntaxKind.StaticKeyword, info.name, toType(info), info.kind === ValueKind.Const ? info.comment : undefined));
                        return undefined;
                    case ValueKind.FunctionOrClass:
                        if (!info.namespaceMembers.length) { // Else, can't merge a static method with a namespace. Must make it a function on the namespace.
                            //test inner class...
                            const x = parseClassOrFunctionBody(info.source); //name
                            if (x && !(typeof x !== "number" && x.kind === SyntaxKind.Constructor)) {
                                const { parameters, returnType } = getParameterListAndReturnType(x); //dup?
                                classStaticMembers.push(create.method(SyntaxKind.StaticKeyword, info.name, parameters, returnType));
                                return undefined;
                            }
                        }
                }
            }
            return toStatements(info, OutputKind.NamespaceMember);
            //return info; //so, do nothing if not a class...
        });

        const ns = namespaceMembers2.length === 0 ? emptyArray : [create.namespace(mod, name, namespaceMembers2)];
        //ternary
        if (classStaticMembers) {
            return [create.cls(mod, name,  [...classStaticMembers, ...(parameters.length ? [create.ctr(parameters)] : emptyArray), ...classNonStaticMembers]), ...ns];
        } else {
            return [create.fn(mod, name, parameters, returnType), ...ns]
        }
    }

    function toClassNonStaticMember(info: ValueInfo): ClassElement | undefined {
        //ignore non-functions on the prototype
        if (info.kind !== ValueKind.FunctionOrClass) return undefined;
        const x = parseClassOrFunctionBody(info.source); //name
        if (!x || (typeof x !== "number" && x.kind === SyntaxKind.Constructor)) return undefined; //dup
        const { parameters, returnType } = getParameterListAndReturnType(x);
        return create.method(/*modifier*/ undefined, info.name, parameters, returnType); //dup-ish of other create.method
    }

    function toType(v: ValueInfo): TypeNode {
        switch (v.kind) {
            case ValueKind.Const:
                return create.typeReference(v.typeName);
            case ValueKind.Array:
                return createArrayTypeNode(toType(v.inner));
            case ValueKind.FunctionOrClass:
                return create.typeReference("Function"); //normally we create a fn declaration. But for fn in array we do this.
            case ValueKind.Object:
                return createTypeLiteralNode(v.members.map(m => create.propertySignature(m.name, toType(m))));
            default:
                return Debug.assertNever(v); //necessary with new lkg?
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

    function getParameterListAndReturnType(fnAst: FunctionOrConstructor): { readonly parameters: ReadonlyArray<ParameterDeclaration>, readonly returnType: TypeNode } {
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
    type FunctionOrConstructor = FunctionOrConstructorNode | number;
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
