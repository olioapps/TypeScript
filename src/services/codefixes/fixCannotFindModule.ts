/* @internal */
namespace ts.codefix {
    const fixName = "fixCannotFindModule";
    const fixIdInstallTypesPackage = "installTypesPackage";
    const fixIdGenerateTypes = "generateTypes";

    const errorCodeCannotFindModule = Diagnostics.Cannot_find_module_0.code;

    const errorCodes = [
        errorCodeCannotFindModule,
        Diagnostics.Could_not_find_a_declaration_file_for_module_0_1_implicitly_has_an_any_type.code,
    ];
    registerCodeFix({
        errorCodes,
        getCodeActions: context => {
            const { host, sourceFile, span: { start } } = context;
            const packageName = tryGetImportedPackageName(sourceFile, start);
            if (packageName === undefined) return undefined;
            const typesPackageName = getTypesPackageNameToInstall(packageName, host, context.errorCode);
            return typesPackageName === undefined
                ? singleElementArray(tryGetGenerateTypesAction(context, packageName))
                : [createCodeFixAction(fixName, /*changes*/ [], [Diagnostics.Install_0, typesPackageName], fixIdInstallTypesPackage, Diagnostics.Install_all_missing_types_packages, getInstallCommand(sourceFile.fileName, typesPackageName))];
        },
        fixIds: [fixIdInstallTypesPackage, fixIdGenerateTypes],
        getAllCodeActions: context => codeFixAll(context, errorCodes, (changes, diag, commands) => {
            const packageName = tryGetImportedPackageName(diag.file, diag.start);
            if (packageName === undefined) return undefined;
            switch (context.fixId) {
                case fixIdInstallTypesPackage:
                    const pkg = getTypesPackageNameToInstall(packageName, context.host, diag.code);
                    if (pkg) {
                        commands.push(getInstallCommand(diag.file.fileName, pkg));
                    }
                    break;
                case fixIdGenerateTypes:
                    const command = tryGenerateTypes(changes, packageName, context);
                    if (command) commands.push(command);
                    break;
                default:
                    Debug.fail(`Bad fixId: ${context.fixId}`);
            }
        }),
    });

    function tryGetGenerateTypesAction(context: CodeFixContextBase, packageName: string): CodeFixAction | undefined {
        let command: GenerateTypesAction | undefined;
        const changes = textChanges.ChangeTracker.with(context, t => { command = tryGenerateTypes(t, packageName, context) });
        return command && createCodeFixAction(fixName, changes, [Diagnostics.Generate_types_for_0, packageName], fixIdGenerateTypes, Diagnostics.Generate_types_for_all_packages_without_types, command);
    }

    function tryGenerateTypes(changes: textChanges.ChangeTracker, packageName: string, context: CodeFixContextBase): GenerateTypesAction | undefined {
        const { configFile } = context.program.getCompilerOptions();
        const typesDir = configFile && getOrCreateTypesDirectory(configFile, changes);
        if (typesDir === undefined) return undefined;

        const file = context.sourceFile.fileName;
        const fileToGenerateTypesFor = typesDir && tryResolveJavaScriptModule(packageName, getDirectoryPath(file), context.host as ModuleResolutionHost); // TODO: GH#18217
        return fileToGenerateTypesFor === undefined ? undefined : { type: "generate types", file, fileToGenerateTypesFor, outputFileName: combinePaths(typesDir, packageName + ".d.ts") };
    }

    //TODO: typeRoots is wrong. Change "paths" instead!!!
    //will need to reverse-parse path mappings
    // If no types directory exists yet, adds it to tsconfig.json
    function getOrCreateTypesDirectory(tsconfig: TsConfigSourceFile, changes: textChanges.ChangeTracker): string {
        const defaultName = "types";

        const tsconfigObjectLiteral = getTsConfigObjectLiteralExpression(tsconfig);
        if (!tsconfigObjectLiteral) {
            return defaultName;
        }

        const newTypeRootsProperty = createPropertyAssignment(createStringLiteral("typeRoots"), createArrayLiteral([createStringLiteral("node_modules"), createStringLiteral(defaultName)]));

        const compilerOptionsProperty = findProperty(tsconfigObjectLiteral, "compilerOptions");
        if (!compilerOptionsProperty) {
            //test
            changes.insertNodeAtObjectStart(tsconfig, tsconfigObjectLiteral, createPropertyAssignment(createStringLiteral("compilerOptions"), createObjectLiteral([newTypeRootsProperty])));
            return defaultName;
        }

        const compilerOptions = compilerOptionsProperty.initializer;
        if (!isObjectLiteralExpression(compilerOptions)) return defaultName;

        const typeRoots = findProperty(compilerOptions, "typeRoots");
        if (!typeRoots) {
            changes.insertNodeAtObjectStart(tsconfig, compilerOptions, newTypeRootsProperty);
            return defaultName;
        }

        const typeRootsArray = typeRoots.initializer;
        if (!isArrayLiteralExpression(typeRootsArray) || typeRootsArray.elements.length === 0) return defaultName;
        //If there's a non-`node_modules` entry there, put types there.
        //todo: path normalization?
        const firstTypesDirectory = find(typeRootsArray.elements, (r): r is StringLiteral => isStringLiteral(r) && r.text !== "node_modules");
        if (firstTypesDirectory) {
            return firstTypesDirectory.text;
        }
        else {
            changes.insertNodeAfter(tsconfig, last(typeRootsArray.elements), createStringLiteral(defaultName));
            return defaultName;
        }
    }

    function findProperty(obj: ObjectLiteralExpression, name: string): PropertyAssignment | undefined {
        return find(obj.properties, (p): p is PropertyAssignment => isPropertyAssignment(p) && !!p.name && isStringLiteral(p.name) && p.name.text === name)
    }

    function getInstallCommand(fileName: string, packageName: string): InstallPackageAction {
        return { type: "install package", file: fileName, packageName };
    }

    function tryGetImportedPackageName(sourceFile: SourceFile, pos: number): string | undefined {
        const moduleName = cast(getTokenAtPosition(sourceFile, pos), isStringLiteral).text;
        const { packageName } = getPackageName(moduleName); //todo: only if it is global!
        return isExternalModuleNameRelative(packageName) ? undefined : packageName;
    }

    function getTypesPackageNameToInstall(packageName: string, host: LanguageServiceHost, diagCode: number): string | undefined {
        return diagCode === errorCodeCannotFindModule
            ? (JsTyping.nodeCoreModules.has(packageName) ? "@types/node" : undefined)
            : (host.isKnownTypesPackageName!(packageName) ? getTypesPackageName(packageName) : undefined); // TODO: GH#18217
    }
}
