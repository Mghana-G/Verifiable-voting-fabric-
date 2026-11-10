# Commands reference

All commands used during the build, copy-paste ready. This feeds Chapter 5.3.

## Phase 0 — Environment setup

```bash
# Update apt and install base tools
sudo apt-get update -qq
sudo apt-get install -y git curl tmux htop build-essential python3-venv

# Install Docker Engine from the official repo
curl -fsSL https://download.docker.com/linux/ubuntu/gpg | sudo install -m 0755 -D /dev/stdin /etc/apt/keyrings/docker.asc
echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo "$VERSION_CODENAME") stable" | sudo tee /etc/apt/sources.list.d/docker.list
sudo apt-get update -qq
sudo apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
sudo usermod -aG docker labadmin

# Verify Docker
sudo docker run --rm hello-world
docker --version
docker compose version

# Install Node.js 20 (NodeSource)
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs
node --version
npm --version

# Extend partition to use full 62 GB disk (run once, then reboot optional)
sudo parted /dev/sda resizepart 2 100%
sudo resize2fs /dev/sda2
df -h /

# Clone Hyperledger Fabric samples and install binaries + images
mkdir -p ~/fabric-samples
cd ~/fabric-samples
curl -sSLO https://raw.githubusercontent.com/hyperledger/fabric/main/scripts/install-fabric.sh
chmod +x install-fabric.sh
./install-fabric.sh --fabric-version 2.5.12 --ca-version 1.5.15 docker binary samples

# Add Fabric binaries to PATH (append to ~/.bashrc)
echo 'export PATH=$PATH:$HOME/fabric-samples/bin' >> ~/.bashrc
source ~/.bashrc

# Verify Fabric binaries
peer version
configtxgen --version

# Bring up the stock test-network (exit-gate proof)
cd ~/fabric-samples/test-network
./network.sh up createChannel -ca -s couchdb
./network.sh deployCC -ccn basic -ccp ../asset-transfer-basic/chaincode-javascript -ccl javascript
peer chaincode invoke -o localhost:7050 --ordererTLSHostnameOverride orderer.example.com --tls --cafile "${PWD}/organizations/ordererOrganizations/example.com/orderers/orderer.example.com/msp/tlscacerts/tlsca.example.com-cert.pem" -C mychannel -n basic --peerAddresses localhost:7051 --tlsRootCertFiles "${PWD}/organizations/peerOrganizations/org1.example.com/peers/peer0.org1.example.com/tls/ca.crt" --peerAddresses localhost:9051 --tlsRootCertFiles "${PWD}/organizations/peerOrganizations/org2.example.com/peers/peer0.org2.example.com/tls/ca.crt" -c '{"function":"InitLedger","Args":[]}'
peer chaincode query -C mychannel -n basic -c '{"Args":["GetAllAssets"]}'
./network.sh down
```

## Phase 1 — Network foundation

```bash
cd ~/voting-network/network

# Full network lifecycle
bash scripts/01-generate-crypto.sh   # cryptogen + fabric-ca material
bash scripts/02-generate-artifacts.sh  # genesis block
bash scripts/03-network-up.sh          # 17 containers up
bash scripts/04-create-channel.sh      # osnadmin join + peer channel join

# Health check (exit gate)
bash scripts/health-check.sh

# Teardown (removes containers, volumes, generated dirs)
bash scripts/99-network-down.sh

# Idempotency test (should complete well under 5 min)
bash scripts/99-network-down.sh && \
bash scripts/01-generate-crypto.sh && \
bash scripts/02-generate-artifacts.sh && \
bash scripts/03-network-up.sh && \
bash scripts/04-create-channel.sh

# TLS verification (run while network is up)
openssl s_client -connect localhost:7051 \
  -CAfile organizations/peerOrganizations/orgiebc.example.com/peers/peer0.orgiebc.example.com/tls/ca.crt \
  -servername peer0.orgiebc.example.com </dev/null 2>&1 | grep -E "Verify|subject"

# Raft leader check
source scripts/env-peer.sh
setPeer IEBC
ORDERER_TLS_CA="organizations/ordererOrganizations/orgorderer.example.com/tlsca/tlsca.orgorderer.example.com-cert.pem"
O1_CERT="organizations/ordererOrganizations/orgorderer.example.com/orderers/orderer1.orgorderer.example.com/tls/server.crt"
O1_KEY="organizations/ordererOrganizations/orgorderer.example.com/orderers/orderer1.orgorderer.example.com/tls/server.key"
osnadmin channel list --orderer-address localhost:9443 --ca-file "$ORDERER_TLS_CA" --client-cert "$O1_CERT" --client-key "$O1_KEY"
docker logs orderer1.orgorderer.example.com 2>&1 | grep -i "raft\|leader\|elected"
```

## Phase 2 — Chaincode

```bash
cd ~/voting-network

# Unit tests (must pass before every deploy)
npm --prefix chaincode/voting test

# Deploy chaincode (package → install → approve → commit)
cd network
bash scripts/05-deploy-chaincode.sh

# Load candidates
bash scripts/06-init-candidates.sh

# Smoke test (exit gate 3: MintVAT + CastBallot + GetAuditInvariant)
cd ~/voting-network
node test/smoke-phase2.js

# Exit gate 2: verify committed chaincode
cd network
source scripts/env-peer.sh
setPeer IEBC
peer lifecycle chaincode querycommitted -C votingchannel -n voting --output json

# Exit gate 4: private data enforcement
# OrgIEBC — should succeed (exit 0)
setPeer IEBC
peer chaincode query -C votingchannel -n voting \
  -c '{"function":"MintVAT","Args":["test-voter","election2027","PS-001"]}'

# OrgMedia — should fail with "does not have read access permission"
setPeer Media
peer chaincode query -C votingchannel -n voting \
  -c '{"function":"MintVAT","Args":["test-voter","election2027","PS-001"]}'

# Rebuild chaincode image (after entrypoint changes; same package hash, new image layer)
PKG_HASH=$(sha256sum network/voting.tar.gz | awk '{print $1}')
cd /tmp/chaincode-prebuild
DOCKER_BUILDKIT=0 docker build -t "voting-chaincode-base:${PKG_HASH}" .
for P in peer0.orgiebc.example.com peer0.orgjudiciary.example.com \
          peer0.orgcivilsociety.example.com peer0.orgmedia.example.com; do
  docker tag "voting-chaincode-base:${PKG_HASH}" "dev-${P}-voting_1.0:${PKG_HASH}"
done

# Redeploy external builder run script to all peers
SCRIPT=~/voting-network/network/scripts/chaincode-run-builder.sh
for P in peer0.orgiebc.example.com peer0.orgjudiciary.example.com \
          peer0.orgcivilsociety.example.com peer0.orgmedia.example.com; do
  docker cp "${SCRIPT}" "${P}:/builders/node-docker/bin/run"
  docker exec "${P}" chmod +x /builders/node-docker/bin/run
done
```

## Phase 3 — Client app, voter generator, verification dashboard

```bash
cd ~/voting-network

# Generate voter registry (12,000 rows, seed 169774)
# Requires faker: python3 /usr/share/python-wheels/pip-24.0-py3-none-any.whl/pip install --user --break-system-packages faker
python3 voter-generator/generate.py --count 12000 --seed 169774

# Verify row count
python3 -c "import sqlite3; c=sqlite3.connect('voter-generator/registry.db'); print('rows:', c.execute('SELECT COUNT(*) FROM voters').fetchone()[0]); c.close()"

# Install client-app dependencies
npm --prefix client-app install

# Start client app (port 3000) — set IEBC_USER1_DIR if needed
node client-app/index.js

# Install verification-dashboard dependencies
npm --prefix verification-dashboard install

# Start dashboard (port 4000)
ELECTION_ID=election2027 node verification-dashboard/index.js

# Query dashboard audit endpoint
curl -s "http://localhost:4000/api/audit?electionID=election2027" | python3 -m json.tool

# Install test harness dependencies
npm --prefix test install

# Run 50-vote end-to-end harness (exit gate 1)
node test/lib/harness.js --count 50 --election election2027-harness

# If peer blacklists chaincode after a container crash (exit 137), restart the peer:
docker restart peer0.orgiebc.example.com
```

## Phase 0 — Exit-gate re-run (2026-09-21)

```bash
# Restart stopped containers and re-run invoke/query for evidence capture
cd ~/fabric-samples/test-network
docker start couchdb0 couchdb1
docker start orderer.example.com
docker start peer0.org1.example.com peer0.org2.example.com
sleep 5

export PATH=$PATH:$HOME/fabric-samples/bin
export FABRIC_CFG_PATH="${HOME}/fabric-samples/config/"
export CORE_PEER_TLS_ENABLED=true
export CORE_PEER_LOCALMSPID="Org1MSP"
export CORE_PEER_MSPCONFIGPATH="${HOME}/fabric-samples/test-network/organizations/peerOrganizations/org1.example.com/users/Admin@org1.example.com/msp"
export CORE_PEER_TLS_ROOTCERT_FILE="${HOME}/fabric-samples/test-network/organizations/peerOrganizations/org1.example.com/peers/peer0.org1.example.com/tls/ca.crt"
export CORE_PEER_ADDRESS=localhost:7051

# Invoke
peer chaincode invoke \
  -o localhost:7050 --ordererTLSHostnameOverride orderer.example.com --tls \
  --cafile "${HOME}/fabric-samples/test-network/organizations/ordererOrganizations/example.com/orderers/orderer.example.com/msp/tlscacerts/tlsca.example.com-cert.pem" \
  -C mychannel -n basic \
  --peerAddresses localhost:7051 \
  --tlsRootCertFiles "${HOME}/fabric-samples/test-network/organizations/peerOrganizations/org1.example.com/peers/peer0.org1.example.com/tls/ca.crt" \
  --peerAddresses localhost:9051 \
  --tlsRootCertFiles "${HOME}/fabric-samples/test-network/organizations/peerOrganizations/org2.example.com/peers/peer0.org2.example.com/tls/ca.crt" \
  -c '{"function":"InitLedger","Args":[]}'

# Query
peer chaincode query -C mychannel -n basic -c '{"Args":["GetAllAssets"]}'

# Tear down (removes containers, volumes, networks, chaincode images)
cd ~/fabric-samples/test-network && ./network.sh down
```

## Phase 4 — Validation test suite

```bash
cd ~/voting-network/test

# Run the full suite (1a, 1b, 3, 4a, 4b, 5, 6, then 2 last), 3 runs each
./run-all.sh 1000          # arg = test3 vote count

# Run an individual test
node test1a-double-voting-sequential.js <runIndex>
node test1b-double-voting-concurrent.js <runIndex>
node test2-insider-modification.js <runIndex>
node test3-parity-audit.js <runIndex> <count>
node test4a-replay-byte-identical.js <runIndex>
node test4b-replay-argument-tuple.js <runIndex>
node test5-tampered-ballot.js <runIndex>
bash test6-invalid-endorsement.sh <runIndex>

# Regenerate evidence/SUMMARY.md from whatever evidence/<test>/ dirs exist
node lib/summarize.js

# Health check after any peer stop/restart (e.g. after test2's rebuild-dbs)
cd ~/voting-network/network && bash scripts/health-check.sh

# Recover from an interrupted background run (VM suspend, killed process, etc.)
ps -ef | grep run-all.sh                # find the process group
kill -TERM -<PGID>                      # negative PID = whole process group

# Wait for a peer to catch up after rebuild-dbs + restart (replay time scales
# with chain length, ~66-75ms/block observed — do not assume a fixed wait)
source ~/voting-network/network/scripts/env-peer.sh
export PATH=$PATH:$HOME/fabric-samples/bin
export FABRIC_CFG_PATH=$HOME/fabric-samples/config/
TARGET=<iebc-height>
until setPeer Media && HEIGHT=$(peer channel getinfo -c votingchannel 2>/dev/null \
    | sed 's/^.*Blockchain info: //' | python3 -c 'import sys,json; print(json.load(sys.stdin)["height"])' 2>/dev/null) \
    && [ -n "$HEIGHT" ] && [ "$HEIGHT" -ge "$TARGET" ]; do
  sleep 10
done
```

## Phase 4C — Orderer tuning (DEV-006) and performance sweep (test7)

```bash
cd ~/voting-network/network

# Change BatchTimeout in configtx.yaml, then full rebuild (channel params are
# set at genesis/channel-creation time, so this needs a clean rebuild, not a
# restart)
bash scripts/99-network-down.sh
bash scripts/01-generate-crypto.sh
bash scripts/02-generate-artifacts.sh
bash scripts/03-network-up.sh
bash scripts/04-create-channel.sh
bash scripts/05-deploy-chaincode.sh
bash scripts/06-init-candidates.sh
bash scripts/health-check.sh

# Confirm the effective BatchTimeout from the channel config itself, not the
# source file (configtx.yaml could be correct on disk but never applied)
source scripts/env-peer.sh && setPeer IEBC
export PATH=$PATH:$HOME/fabric-samples/bin FABRIC_CFG_PATH=$HOME/fabric-samples/config/
ORDERER_CA="$PWD/organizations/ordererOrganizations/orgorderer.example.com/tlsca/tlsca.orgorderer.example.com-cert.pem"
peer channel fetch config /tmp/config_block.pb -c votingchannel -o localhost:7050 \
  --ordererTLSHostnameOverride orderer1.orgorderer.example.com --tls --cafile "$ORDERER_CA"
configtxlator proto_decode --input /tmp/config_block.pb --type common.Block --output /tmp/config_block.json
python3 -c "
import json
b = json.load(open('/tmp/config_block.json'))
print(b['data']['data'][0]['payload']['data']['config']['channel_group']['groups']['Orderer']['values']['BatchTimeout']['value']['timeout'])
"

cd ~/voting-network/test

# test7 performance sweep and bounded-concurrency probe
node test7-performance.js sweep 100,500,1000,5000,10000   # comma-separated scales
node test7-performance.js probe 500                        # single scale, contention probe

# If the host/VM restarts mid-run: containers persist ledger state in named
# volumes, so just restart them (no rebuild needed) and verify health
cd ~/voting-network/network
docker compose start
bash scripts/health-check.sh
```

## Dashboard, Phase D1 (docs/DASHBOARD_PLAN.md)

```bash
# Install once, then run in tmux so it survives a dropped SSH session
cd ~/voting-network/dashboard && npm install
tmux new -s dash 'node ~/voting-network/dashboard/server.js'

# From Windows: tunnel, then open http://localhost:5050
ssh -L 5050:localhost:5050 labadmin@<vm-ip>

# Full state as JSON (also written to dashboard/out/state.json)
curl -s http://127.0.0.1:5050/api/state | python3 -m json.tool | less

# Every MISSING field, with the reason
curl -s http://127.0.0.1:5050/api/state | python3 -c "import json,sys; [print(m['path'], '|', m['why']) for m in json.load(sys.stdin)['missing']]"

# Prove D1 makes no network calls: trace every connect() during a collection
strace -f -qq -e trace=connect -o /tmp/connect.trace node -e "['environment','build','deviations','tests','criteria','performance','screenshots'].forEach(n => require('./dashboard/collectors/' + n).collect())"
grep -c AF_INET /tmp/connect.trace   # expect 0
```

## Dashboard v2

```bash
# Create the administrator password file (gitignored); read the value from the file itself
printf 'DASHBOARD_ADMIN_PASSWORD=%s\n' "$(openssl rand -base64 18 | tr -d '/+=' | cut -c1-20)" > ~/voting-network/dashboard/.env && chmod 600 ~/voting-network/dashboard/.env

# Run the dashboard (landing page on http://127.0.0.1:5050)
cd ~/voting-network/dashboard && node server.js

# Reach it from Windows
ssh -L 5050:localhost:5050 labadmin@<vm-address>

# Check the role guards (expect 401, 401, 401, then 200)
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:5050/api/voter/state
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:5050/api/admin/overview
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:5050/api/state
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:5050/api/verify/results

# Confirm no voter ID or voter hash has been written under dashboard/out/
python3 - <<'PY'
import sqlite3, os, re
c = sqlite3.connect('file:voter-generator/registry.db?mode=ro', uri=True)
needles = {x for r in c.execute('select voter_id, hash from voters') for x in r}
hits = [(os.path.join(r, f), t) for r, _, fs in os.walk('dashboard/out') for f in fs
        for t in set(re.findall(r'KE\d{8}|[0-9a-f]{64}', open(os.path.join(r, f), errors='ignore').read())) if t in needles]
print('hits:', hits)
PY
```

