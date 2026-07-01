{
  description = "Procedural 12×18in medieval board-poster generator (self-contained board.html)";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    flake-utils.url = "github:numtide/flake-utils";
  };

  outputs =
    { self, nixpkgs, flake-utils }:
    flake-utils.lib.eachDefaultSystem (
      system:
      let
        pkgs = nixpkgs.legacyPackages.${system};
        # One hash for the npm deps, shared by every package (same lockfile).
        # If npm deps change, set to lib.fakeHash, build once, and paste the
        # hash Nix reports back.
        npmDepsHash = "sha256-os6RIrUwkE2QA1MB58CB4a+P925AFpkTPjiOKNOqjsI=";
        version = (pkgs.lib.importJSON ./package.json).version;

        # The self-contained board poster (moved here from the dots repo).
        muscat = pkgs.buildNpmPackage {
          pname = "muscat";
          inherit version npmDepsHash;
          src = self;
          # The `build` script gates on `tsgo --noEmit` (a dev-only preview
          # toolchain); skip it and just run the esbuild bundle.
          buildPhase = ''
            runHook preBuild
            node_modules/.bin/tsx build.ts
            runHook postBuild
          '';
          installPhase = ''
            runHook preInstall
            mkdir -p $out
            cp dist/board.html $out/board.html
            ln -s board.html $out/index.html
            runHook postInstall
          '';
          meta = {
            description = "Procedural 12×18in medieval board-poster generator";
            homepage = "https://github.com/xav-ie/Muscat";
            platforms = pkgs.lib.platforms.all;
          };
        };

        # A runnable that renders just the castle to a recoloured preview SVG
        # (written to stdout). Parameterised by a JSON config passed as an arg:
        #   nix run .#generate-preview -- /abs/path/preview.config.json > out.svg
        generate-preview = pkgs.buildNpmPackage {
          pname = "muscat-generate-preview";
          inherit version npmDepsHash;
          src = self;
          dontNpmBuild = true;
          nativeBuildInputs = [ pkgs.makeWrapper ];
          installPhase = ''
            runHook preInstall
            mkdir -p $out/libexec
            cp -r . $out/libexec/muscat
            makeWrapper ${pkgs.nodejs}/bin/node $out/bin/generate-preview \
              --add-flags "$out/libexec/muscat/node_modules/tsx/dist/cli.mjs" \
              --add-flags "$out/libexec/muscat/generate-preview.ts" \
              --chdir "$out/libexec/muscat"
            runHook postInstall
          '';
          meta = {
            description = "Render a recoloured preview SVG of the Muscat castle";
            homepage = "https://github.com/xav-ie/Muscat";
            mainProgram = "generate-preview";
          };
        };

        # Parameterised preview: given a config attrset (castle + recolour
        # options, same shape as PreviewOptions), returns a derivation whose
        # single-file output IS the recoloured preview SVG. Consumers build it
        # and read the result — no committed artifact, no imperative step:
        #   muscat.mkPreview.${system} (builtins.fromJSON (readFile ./cfg.json))
        mkPreview =
          config:
          pkgs.runCommand "muscat-preview.svg" { } ''
            ${generate-preview}/bin/generate-preview \
              ${pkgs.writeText "muscat-preview-config.json" (builtins.toJSON config)} > $out
          '';
      in
      {
        packages = {
          default = muscat;
          inherit muscat generate-preview;
          # Smoke-test build of the raw (un-recoloured) preview.
          preview-example = mkPreview { };
        };
        apps.generate-preview = {
          type = "app";
          program = "${generate-preview}/bin/generate-preview";
        };
        inherit mkPreview;
        devShells.default = pkgs.mkShell {
          packages = [ pkgs.nodejs ];
        };
      }
    );
}
