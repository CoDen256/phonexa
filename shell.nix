{ pkgs ? import <nixpkgs> {} }:

pkgs.mkShell {
  buildInputs = with pkgs; [
    python312
    python312Packages.parselmouth
    stdenv.cc.cc.lib
  ];

  shellHook = ''
    export LD_LIBRARY_PATH=${pkgs.stdenv.cc.cc.lib}/lib:$LD_LIBRARY_PATH

    # Auto-create and activate venv
    if [ ! -d .venv ]; then
      python -m venv .venv
    fi
    source .venv/bin/activate

    # Install deps if needed
    pip install -r requirements.txt --quiet
  '';
}