{ pkgs ? import <nixpkgs> {} }:
let
  parselmouth = pkgs.python312Packages.parselmouth.overrideAttrs (old: {
    # override the fmt submodule fetch with the correct hash
    prePatch = (old.prePatch or "") + "";
    # actually easier to override the whole src:
    src = pkgs.fetchFromGitHub {
      owner = "YannickJadoul";
      repo = "Parselmouth";
      rev = "v0.4.7";
      hash = "sha256-8ZpQL//pmz9Yh89FzzmhdJDcJ9gEVayMeKURdn+nD5E=";
      fetchSubmodules = true;
    };
  });
in
pkgs.mkShell {
  buildInputs = with pkgs; [
    python312
    parselmouth
    stdenv.cc.cc.lib
  ];
  shellHook = ''
    export LD_LIBRARY_PATH=${pkgs.stdenv.cc.cc.lib}/lib:$LD_LIBRARY_PATH
    if [ ! -d .venv ]; then
      python -m venv .venv
    fi
    source .venv/bin/activate
    pip install -r requirements.txt --quiet
  '';
}