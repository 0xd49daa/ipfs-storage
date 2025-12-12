# Issues

- Phase 0: All previously noted review issues have been addressed and no open items remain.
- Phase 1: All previously noted review issues have been addressed and no open items remain.
  - Fixed: `bigintToNumber()` helper now validates values are within `Number.MAX_SAFE_INTEGER` before conversion, throwing `ValidationError` if precision would be lost.
  - Fixed: `recipientKeyInfoToProto()` and `recipientKeyProtoToInfo()` now validate nonce (24 bytes) and ciphertext (48 bytes) sizes, failing early with `ValidationError` instead of late decryption errors.
