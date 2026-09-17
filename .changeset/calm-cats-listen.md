---
'@zapo-js/voip': patch
---

Surface the caller phone JID (`caller_pn`) from incoming call offers on the emitted
call state, so a caller identified by a LID can be matched to their phone number.
Media derivation is unchanged: the peer SSRC and the SRTP keys stay on the LID device
JID, which is what the peer derives from.
