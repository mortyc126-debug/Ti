const popover = document.createElement("div");
popover.setAttribute("popover", "");
document.body.append(popover);

popover.togglePopover();
console.log(popover.matches(":popover-open"));
popover.togglePopover();
console.log(popover.matches(":popover-open"));
