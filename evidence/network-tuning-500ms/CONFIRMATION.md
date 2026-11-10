# DEV-006 Orderer BatchTimeout tuning — confirmation evidence

Date: 2026-09-28

## Rebuild sequence
99-network-down.sh, 01-generate-crypto.sh, 02-generate-artifacts.sh,
03-network-up.sh, 04-create-channel.sh, 05-deploy-chaincode.sh,
06-init-candidates.sh — all completed cleanly.

## health-check.sh: 11/11 PASS, all 4 peers at height 10.

## Effective BatchTimeout confirmed from the decoded channel config
(not from configtx.yaml — the file could be correct on disk but never
actually applied):

```
peer channel fetch config /tmp/config_block.pb -c votingchannel ...
configtxlator proto_decode --input /tmp/config_block.pb --type common.Block --output /tmp/config_block.json
python3 -> config['channel_group']['groups']['Orderer']['values']['BatchTimeout']['value']['timeout']
=> "500ms"
```

Full decoded block: `config_block_decoded.json` in this directory.

## 1-vote smoke test
mintMs=1071, castMs=754, GetAuditInvariant={"burnedCount":1,"tallyTotal":1}
