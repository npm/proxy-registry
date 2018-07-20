# proxy-registry

This is a simple proxy registry that uses your existing npm cache.

```console
$ npx iarna/proxy-registry
Listening on: https://localhost:22000
To use: npm config set registry https://localhost:22000
^C to close server
```

## OPTIONS

```
Options:
  --help     Show help                                                 [boolean]
  --version  Show version number                                       [boolean]
  --port     the port to listen on                     [number] [default: 22000]
  --shell    run a shell configured to talk to this proxy
                                                       [boolean] [default: true]
  --log      log requests (defaults to off when running a shell, on when not)
                                                                       [boolean]
```

