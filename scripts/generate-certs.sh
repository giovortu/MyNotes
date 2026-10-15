#!/usr/bin/env bash
set -e

CERTS_DIR="${1:-./certs}"
mkdir -p "$CERTS_DIR"

echo "==> Generazione certificati SSL per MyNotes PWA..."

IPS=("127.0.0.1" "0.0.0.0")
for ip in $(ip -o -4 addr show 2>/dev/null | awk '{print $4}' | cut -d/ -f1); do
  if [[ "$ip" != "127.0.0.1" && "$ip" != "0.0.0.0" ]]; then
    IPS+=("$ip")
  fi
done

if [[ -n "$EXTRA_SAN" ]]; then
  IFS=',' read -ra ADDR <<< "$EXTRA_SAN"
  for val in "${ADDR[@]}"; do
    val=$(echo "$val" | xargs)
    if [[ "$val" =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
      IPS+=("$val")
    fi
  done
fi

SAN_LIST="DNS:localhost,DNS:*.local,DNS:archivio-note"
UNIQUE_IPS=($(printf "%s\n" "${IPS[@]}" | sort -u))
for ip in "${UNIQUE_IPS[@]}"; do
  SAN_LIST+=",IP:$ip"
done

if [[ -n "$EXTRA_SAN" ]]; then
  IFS=',' read -ra ADDR <<< "$EXTRA_SAN"
  for val in "${ADDR[@]}"; do
    val=$(echo "$val" | xargs)
    if [[ ! "$val" =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
      SAN_LIST+=",DNS:$val"
    fi
  done
fi

echo "SAN inclusi: $SAN_LIST"

if [[ ! -f "$CERTS_DIR/ca.key" || ! -f "$CERTS_DIR/ca.crt" ]]; then
  echo "Generazione Root CA..."
  openssl req -x509 -newkey rsa:2048 -nodes -days 3650 \
    -keyout "$CERTS_DIR/ca.key" \
    -out "$CERTS_DIR/ca.crt" \
    -subj "/CN=MyNotes Local Root CA/O=MyNotes/C=IT" \
    -addext "basicConstraints=critical,CA:TRUE" \
    -addext "keyUsage=critical,digitalSignature,cRLSign,keyCertSign" \
    -addext "subjectKeyIdentifier=hash"
fi

echo "Generazione chiave server e CSR..."
openssl req -new -newkey rsa:2048 -nodes \
  -keyout "$CERTS_DIR/server.key" \
  -out "$CERTS_DIR/server.csr" \
  -subj "/CN=MyNotes Server/O=MyNotes/C=IT"

EXT_FILE=$(mktemp)
cat <<EXTEOF > "$EXT_FILE"
basicConstraints = critical,CA:FALSE
keyUsage = critical,digitalSignature,keyEncipherment
extendedKeyUsage = serverAuth
subjectKeyIdentifier = hash
authorityKeyIdentifier = keyid,issuer
subjectAltName = $SAN_LIST
EXTEOF

echo "Firma certificato server con la Root CA..."
openssl x509 -req -in "$CERTS_DIR/server.csr" \
  -CA "$CERTS_DIR/ca.crt" \
  -CAkey "$CERTS_DIR/ca.key" \
  -CAcreateserial \
  -out "$CERTS_DIR/server.crt" \
  -days 825 \
  -extfile "$EXT_FILE"

rm -f "$EXT_FILE" "$CERTS_DIR/server.csr"

echo "==> Certificati generati con successo in $CERTS_DIR:"
ls -lh "$CERTS_DIR"
