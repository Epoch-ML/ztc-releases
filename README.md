# ZTC distribution bootstrap

This new repository retains the previously reviewed public publisher code as a
review baseline. It has no configured signing secrets, active Pages feed, or ZTC
release artifacts. The upcoming implementation PR adapts the publisher for the
self-contained ZTC desktop and must be reviewed before any release is dispatched.

`Epoch-ML/zterm-releases` remains the unchanged legacy distribution. Do not invoke
the legacy workflow from this bootstrap. Its release requests are removed here
because they do not belong to this new distribution.
